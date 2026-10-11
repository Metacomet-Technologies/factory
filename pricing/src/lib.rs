//! Reference-model base token rates in USD. Prompt-caching discounts are ignored.
//! History starts when rates are fetched, not at the upstream model release date.

use anyhow::{Context, Result, bail, ensure};
use regex::Regex;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path, time::Duration};

pub const OPENROUTER_URL: &str = "https://openrouter.ai/api/v1/models";
pub const LITELLM_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
pub const DEFAULT_CONFIG: &str = include_str!("../config/references.toml");

#[derive(Debug, Deserialize)]
pub struct Reference {
    pub name: String,
    #[serde(rename = "match")]
    pub pattern: String,
}

pub fn parse_references(text: &str) -> Result<Vec<Reference>> {
    #[derive(Deserialize)]
    struct Config {
        reference: Vec<Reference>,
    }
    let config: Config = toml::from_str(text)?;
    ensure!(
        !config.reference.is_empty(),
        "no reference families configured"
    );
    let mut names = std::collections::BTreeSet::new();
    for reference in &config.reference {
        ensure!(!reference.name.trim().is_empty(), "empty family name");
        ensure!(names.insert(&reference.name), "duplicate family name");
        Regex::new(&reference.pattern).context("invalid reference regex")?;
    }
    Ok(config.reference)
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Model {
    pub model_id: String,
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    pub released_at: Option<i64>,
}

fn rate(per_token: f64) -> Result<f64> {
    let per_mtok = per_token * 1_000_000.0;
    ensure!(
        per_mtok.is_finite() && per_mtok >= 0.0,
        "invalid token rate"
    );
    Ok(per_mtok)
}

pub fn parse_openrouter(text: &str) -> Result<Vec<Model>> {
    #[derive(Deserialize)]
    struct Response {
        data: Vec<Entry>,
    }
    #[derive(Deserialize)]
    struct Entry {
        id: String,
        created: i64,
        pricing: Prices,
    }
    #[derive(Deserialize)]
    struct Prices {
        prompt: String,
        completion: String,
    }
    let response: Response = serde_json::from_str(text)?;
    response
        .data
        .into_iter()
        // Routing entries expose -1/-1 instead of usable fixed token rates.
        .filter(|entry| !(entry.pricing.prompt == "-1" && entry.pricing.completion == "-1"))
        .map(|entry| {
            ensure!(entry.created >= 0, "invalid release timestamp");
            Ok(Model {
                model_id: entry.id,
                input_per_mtok: rate(entry.pricing.prompt.parse()?)?,
                output_per_mtok: rate(entry.pricing.completion.parse()?)?,
                released_at: Some(entry.created),
            })
        })
        .collect()
}

/// Only direct Anthropic/OpenAI prices are compared, never reseller/region prices.
/// LiteLLM has no release timestamps. Refresh joins dates from OpenRouter history.
pub fn parse_litellm(text: &str) -> Result<Vec<Model>> {
    #[derive(Deserialize)]
    struct Entry {
        litellm_provider: Option<String>,
        input_cost_per_token: Option<f64>,
        output_cost_per_token: Option<f64>,
    }
    let entries: BTreeMap<String, Entry> = serde_json::from_str(text)?;
    let sonnet_version = Regex::new(r"^(claude-sonnet-\d+)-(\d{1,2})($|\D.*)$")?;
    let mut models = Vec::new();
    for (id, entry) in entries {
        let canonical = match entry.litellm_provider.as_deref() {
            Some("openai") if !id.contains('/') && id.starts_with("gpt-") => {
                format!("openai/{id}")
            }
            Some("anthropic") if !id.contains('/') && id.starts_with("claude-sonnet-") => {
                format!("anthropic/{}", sonnet_version.replace(&id, "$1.$2$3"))
            }
            _ => continue,
        };
        if let (Some(input), Some(output)) =
            (entry.input_cost_per_token, entry.output_cost_per_token)
        {
            models.push(Model {
                model_id: canonical,
                input_per_mtok: rate(input)?,
                output_per_mtok: rate(output)?,
                released_at: None,
            });
        }
    }
    Ok(models)
}

/// Newest known release wins; equal dates prefer the lexically smaller ID.
/// This makes ties deterministic and prefers an unsuffixed ID over its :batch ID.
pub fn resolve<'a>(reference: &Reference, models: &'a [Model]) -> Result<Option<&'a Model>> {
    let pattern = Regex::new(&reference.pattern)?;
    Ok(models
        .iter()
        .filter(|m| m.released_at.is_some() && pattern.is_match(&m.model_id))
        .max_by(|a, b| {
            a.released_at
                .cmp(&b.released_at)
                .then_with(|| b.model_id.cmp(&a.model_id))
        }))
}

/// Relative difference uses the primary (OpenRouter) rate as its denominator.
pub fn disagrees(primary: &Model, secondary: &Model) -> bool {
    [
        (primary.input_per_mtok, secondary.input_per_mtok),
        (primary.output_per_mtok, secondary.output_per_mtok),
    ]
    .into_iter()
    .any(|(a, b)| b > a * 1.05 || b < a * 0.95)
}

#[derive(Clone, Debug, Serialize)]
pub struct Item {
    pub fetched_at: i64,
    pub kind: String,
    pub family: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct Selection {
    pub model_id: String,
    pub effective_from: i64,
}

#[derive(Debug, Serialize)]
pub struct Rates {
    pub fetched_at: i64,
    pub source: String,
    pub model: Model,
}

#[derive(Debug, Serialize)]
pub struct FamilyStatus {
    pub family: String,
    pub selected: Option<Selection>,
    pub rates: Option<Rates>,
    pub pending: Option<Selection>,
    pub pending_rates: Option<Rates>,
}

pub struct Store {
    connection: Connection,
}

/// A range's rates loaded once. Token rows never execute SQL.
pub struct History {
    selections: Vec<(i64, String)>,
    rates: BTreeMap<String, Vec<(i64, f64, f64)>>,
    pub earliest: Option<(f64, f64)>,
}

impl History {
    pub fn rates_at(&self, at: i64) -> Option<(f64, f64)> {
        let selected = self.selections.partition_point(|(time, _)| *time <= at);
        let (_, model) = self.selections.get(selected.checked_sub(1)?)?;
        let rates = self.rates.get(model)?;
        let index = rates.partition_point(|(time, _, _)| *time <= at);
        let (_, input, output) = rates.get(index.checked_sub(1)?)?;
        Some((*input, *output))
    }
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::from_connection(Connection::open(path)?)
    }

    /// Borrow the owned connection for shared settings, counters and snapshots.
    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    /// Use an existing connection without running schema migrations or taking a write lock.
    pub fn reader(connection: Connection) -> Result<Self> {
        connection.execute_batch("PRAGMA query_only=ON;")?;
        Ok(Self { connection })
    }

    /// Keep selections, rates, and warnings on one committed WAL snapshot.
    pub fn snapshot<T>(&self, read: impl FnOnce(&Self) -> Result<T>) -> Result<T> {
        let transaction = self.connection.unchecked_transaction()?;
        let value = read(self)?;
        transaction.commit()?;
        Ok(value)
    }

    pub fn in_memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    /// Bootstrap the legacy schema on an owner-supplied writer connection.
    pub fn from_connection(connection: Connection) -> Result<Self> {
        connection.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS refreshes (fetched_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS price_snapshots (
               fetched_at INTEGER NOT NULL, source TEXT NOT NULL, model_id TEXT NOT NULL,
               input_per_mtok REAL NOT NULL CHECK(input_per_mtok >= 0),
               output_per_mtok REAL NOT NULL CHECK(output_per_mtok >= 0), released_at INTEGER,
               refresh_id INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS snapshot_lookup ON price_snapshots(model_id, fetched_at);
             CREATE TABLE IF NOT EXISTS reference_selection (
               family TEXT NOT NULL, model_id TEXT NOT NULL, effective_from INTEGER NOT NULL,
               confirmed INTEGER NOT NULL CHECK(confirmed IN (0,1)), refresh_id INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS selection_lookup ON reference_selection(family, effective_from);
             CREATE TABLE IF NOT EXISTS pricing_items (
               fetched_at INTEGER NOT NULL, kind TEXT NOT NULL, family TEXT NOT NULL,
               message TEXT NOT NULL, refresh_id INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS items_refresh ON pricing_items(refresh_id);
             CREATE INDEX IF NOT EXISTS selection_confirmed ON reference_selection(family,confirmed,effective_from);"
        )?;
        Ok(Self { connection })
    }

    /// Three queries per family, regardless of the number of token rows. Includes
    /// predecessor selections/rates and the original pre-history estimate.
    pub fn history(&self, family: &str, until: i64) -> Result<History> {
        let selections = self
            .connection
            .prepare(
                "SELECT effective_from,model_id FROM reference_selection
             WHERE family=?1 AND confirmed=1 AND effective_from<=?2
             ORDER BY effective_from,rowid",
            )?
            .query_map(params![family, until], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut rates = BTreeMap::<String, Vec<(i64, f64, f64)>>::new();
        let mut statement = self.connection.prepare(
            "SELECT model_id,fetched_at,input_per_mtok,output_per_mtok FROM price_snapshots
             WHERE model_id IN (SELECT model_id FROM reference_selection WHERE family=?1 AND confirmed=1)
               AND fetched_at<=?2
             ORDER BY model_id,fetched_at,refresh_id,(source='openrouter'),rowid",
        )?;
        for row in statement.query_map(params![family, until], |r| {
            Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?)))
        })? {
            let (model, rate) = row?;
            rates.entry(model).or_default().push(rate);
        }
        let earliest = self.connection.query_row(
            "SELECT input_per_mtok,output_per_mtok FROM price_snapshots
             WHERE model_id=(SELECT model_id FROM reference_selection WHERE family=?1 AND confirmed=1
                 ORDER BY effective_from,rowid LIMIT 1)
             ORDER BY fetched_at,refresh_id,(source='openrouter') DESC,rowid DESC LIMIT 1",
            [family], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        Ok(History {
            selections,
            rates,
            earliest,
        })
    }

    fn selected(&self, family: &str, at: i64) -> Result<Option<Selection>> {
        Ok(self
            .connection
            .query_row(
                "SELECT model_id,effective_from FROM reference_selection
             WHERE family=?1 AND confirmed=1 AND effective_from<=?2
             ORDER BY effective_from DESC,rowid DESC LIMIT 1",
                params![family, at],
                |r| {
                    Ok(Selection {
                        model_id: r.get(0)?,
                        effective_from: r.get(1)?,
                    })
                },
            )
            .optional()?)
    }

    fn pending(&self, family: &str) -> Result<Option<Selection>> {
        Ok(self
            .connection
            .query_row(
                "SELECT model_id,effective_from FROM reference_selection
             WHERE family=?1 AND confirmed=0
               AND refresh_id = (SELECT MAX(rowid) FROM refreshes)
               AND rowid > COALESCE((SELECT MAX(rowid) FROM reference_selection
                                    WHERE family=?1 AND confirmed=1),0)
             ORDER BY effective_from DESC,rowid DESC LIMIT 1",
                [family],
                |r| {
                    Ok(Selection {
                        model_id: r.get(0)?,
                        effective_from: r.get(1)?,
                    })
                },
            )
            .optional()?)
    }

    fn rates(&self, model_id: &str, at: i64) -> Result<Option<Rates>> {
        Ok(self
            .connection
            .query_row(
                "SELECT fetched_at,source,input_per_mtok,output_per_mtok,released_at
             FROM price_snapshots WHERE model_id=?1 AND fetched_at<=?2
             ORDER BY fetched_at DESC,refresh_id DESC,(source='openrouter') DESC,rowid DESC LIMIT 1",
                params![model_id, at],
                |r| {
                    Ok(Rates {
                        fetched_at: r.get(0)?,
                        source: r.get(1)?,
                        model: Model {
                            model_id: model_id.into(),
                            input_per_mtok: r.get(2)?,
                            output_per_mtok: r.get(3)?,
                            released_at: r.get(4)?,
                        },
                    })
                },
            )
            .optional()?)
    }

    /// Append both source snapshots and decisions atomically. Neither old rates nor
    /// old selections are changed. First-time families also need confirmation.
    pub fn refresh(
        &mut self,
        references: &[Reference],
        primary: &[Model],
        secondary: &[Model],
        fetched_at: i64,
        mut items: Vec<Item>,
    ) -> Result<Vec<Item>> {
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        ensure!(fetched_at >= 0, "invalid fetch timestamp");
        let latest: Option<i64> = self.connection.query_row(
            "SELECT MAX(effective_from) FROM reference_selection",
            [],
            |r| r.get(0),
        )?;
        let latest_fetch: Option<i64> =
            self.connection
                .query_row("SELECT MAX(fetched_at) FROM refreshes", [], |r| r.get(0))?;
        ensure!(
            latest
                .into_iter()
                .chain(latest_fetch)
                .all(|t| fetched_at >= t),
            "fetch timestamp predates history"
        );
        ensure!(
            !primary.is_empty() || !secondary.is_empty(),
            "no usable source models"
        );
        let mut secondary = secondary.to_vec();
        for model in &mut secondary {
            model.released_at = primary
                .iter()
                .find(|p| p.model_id == model.model_id)
                .and_then(|p| p.released_at)
                .or(self.connection.query_row(
                    "SELECT MAX(released_at) FROM price_snapshots WHERE model_id=?1",
                    [&model.model_id],
                    |r| r.get::<_, Option<i64>>(0),
                )?);
        }
        let candidates = if primary.is_empty() {
            &secondary
        } else {
            primary
        };
        let mut pending = Vec::new();
        for reference in references {
            let confirmed = self.selected(&reference.name, fetched_at)?;
            let resolved = resolve(reference, candidates)?;
            if let Some(model) = resolved {
                if confirmed
                    .as_ref()
                    .is_none_or(|s| s.model_id != model.model_id)
                {
                    pending.push((&reference.name, &model.model_id));
                    items.push(Item {
                        fetched_at,
                        kind: "pricing.changed".into(),
                        family: reference.name.clone(),
                        message: format!("pending {}; confirmation required", model.model_id),
                    });
                }
            } else {
                items.push(Item {
                    fetched_at,
                    kind: "warning".into(),
                    family: reference.name.clone(),
                    message: "no matching model with a known release date".into(),
                });
            }
            // Cross-check both the active model and a proposed replacement.
            let mut ids: Vec<&str> = confirmed
                .as_ref()
                .map(|s| s.model_id.as_str())
                .into_iter()
                .collect();
            if let Some(model) = resolved {
                ids.push(&model.model_id);
            }
            ids.sort_unstable();
            ids.dedup();
            for id in ids {
                let a = primary.iter().find(|m| m.model_id == id);
                let b = secondary.iter().find(|m| m.model_id == id);
                let message = match (a, b) {
                    (Some(a), Some(b)) if disagrees(a, b) => Some(format!(
                        "{id}: rates disagree >5%; OpenRouter ${}/{} vs LiteLLM ${}/{} per Mtok (input/output)",
                        a.input_per_mtok, a.output_per_mtok, b.input_per_mtok, b.output_per_mtok
                    )),
                    (None, _) | (_, None) => Some(format!(
                        "{id}: cross-check unavailable; model missing from a source"
                    )),
                    _ => None,
                };
                if let Some(message) = message {
                    items.push(Item {
                        fetched_at,
                        kind: "warning".into(),
                        family: reference.name.clone(),
                        message,
                    });
                }
            }
        }
        transaction.execute("INSERT INTO refreshes VALUES (?1)", [fetched_at])?;
        let refresh_id = transaction.last_insert_rowid();
        for (source, models) in [("openrouter", primary), ("litellm", secondary.as_slice())] {
            for model in models {
                rate(model.input_per_mtok / 1_000_000.0)?;
                rate(model.output_per_mtok / 1_000_000.0)?;
                ensure!(
                    model.released_at.is_none_or(|t| t >= 0),
                    "invalid release timestamp"
                );
                transaction.execute(
                    "INSERT INTO price_snapshots VALUES (?1,?2,?3,?4,?5,?6,?7)",
                    params![
                        fetched_at,
                        source,
                        model.model_id,
                        model.input_per_mtok,
                        model.output_per_mtok,
                        model.released_at,
                        refresh_id
                    ],
                )?;
            }
        }
        for (family, id) in pending {
            transaction.execute(
                "INSERT INTO reference_selection VALUES (?1,?2,?3,0,?4)",
                params![family, id, fetched_at, refresh_id],
            )?;
        }
        for item in &items {
            transaction.execute(
                "INSERT INTO pricing_items VALUES (?1,?2,?3,?4,?5)",
                params![
                    item.fetched_at,
                    item.kind,
                    item.family,
                    item.message,
                    refresh_id
                ],
            )?;
        }
        transaction.commit()?;
        Ok(items)
    }

    pub fn confirm(&mut self, family: &str, at: i64) -> Result<Selection> {
        // Lock before reading the candidate so another process cannot refresh it
        // between lookup and confirmation.
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let pending = self
            .pending(family)?
            .context("no pending change for this family")?;
        let latest: Option<i64> = transaction.query_row(
            "SELECT MAX(effective_from) FROM reference_selection",
            [],
            |r| r.get(0),
        )?;
        ensure!(
            at >= pending.effective_from && latest.is_none_or(|t| at >= t),
            "confirmation predates pending change"
        );
        transaction.execute(
                "INSERT INTO reference_selection VALUES (?1,?2,?3,1,(SELECT MAX(rowid) FROM refreshes))",
                params![family, pending.model_id, at],
            )?;
        transaction.commit()?;
        Ok(Selection {
            model_id: pending.model_id,
            effective_from: at,
        })
    }

    /// Price tokens using the confirmed model and latest observed rates AT `at`.
    /// No future observations, caching discounts, long-context tiers, tools,
    /// images, or audio charges are included. The result is USD, not rounded cents.
    pub fn cost(
        &self,
        family: &str,
        prompt_tokens: u64,
        output_tokens: u64,
        at: i64,
    ) -> Result<f64> {
        let selected = self
            .selected(family, at)?
            .context("no confirmed selection at this timestamp")?;
        let rates = self
            .rates(&selected.model_id, at)?
            .context("no rates at this timestamp")?;
        Ok((prompt_tokens as f64 * rates.model.input_per_mtok
            + output_tokens as f64 * rates.model.output_per_mtok)
            / 1_000_000.0)
    }

    pub fn show(&self, references: &[Reference], at: i64) -> Result<Vec<FamilyStatus>> {
        references
            .iter()
            .map(|reference| {
                let selected = self.selected(&reference.name, at)?;
                let rates = selected
                    .as_ref()
                    .map(|s| self.rates(&s.model_id, at))
                    .transpose()?
                    .flatten();
                let pending = self.pending(&reference.name)?;
                let pending_rates = pending
                    .as_ref()
                    .map(|s| self.rates(&s.model_id, at))
                    .transpose()?
                    .flatten();
                Ok(FamilyStatus {
                    family: reference.name.clone(),
                    selected,
                    rates,
                    pending,
                    pending_rates,
                })
            })
            .collect()
    }

    /// The newest refresh's warnings/items; historical items remain in SQLite.
    pub fn items(&self) -> Result<Vec<Item>> {
        let mut statement = self.connection.prepare(
            "SELECT fetched_at,kind,family,message FROM pricing_items
             WHERE refresh_id=(SELECT MAX(rowid) FROM refreshes) ORDER BY rowid",
        )?;
        Ok(statement
            .query_map([], |r| {
                Ok(Item {
                    fetched_at: r.get(0)?,
                    kind: r.get(1)?,
                    family: r.get(2)?,
                    message: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

/// Fetch both feeds independently. One failure is a recorded warning; both failing
/// aborts without changing the database. OpenRouter is authoritative when present.
pub fn refresh_live(store: &mut Store, references: &[Reference], at: i64) -> Result<Vec<Item>> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60))
        .user_agent("factory-pricing/0.1")
        .build()?;
    let mut items = Vec::new();
    let mut fetch = |url: &str, parser: fn(&str) -> Result<Vec<Model>>, source: &str| {
        let result = (|| {
            let text = client.get(url).send()?.error_for_status()?.text()?;
            let models = parser(&text)?;
            ensure!(!models.is_empty(), "source returned no usable models");
            Ok(models)
        })();
        match result {
            Ok(models) => models,
            Err(error) => {
                items.push(Item {
                    fetched_at: at,
                    kind: "warning".into(),
                    family: "*".into(),
                    message: format!("{source} unavailable: {error:#}"),
                });
                Vec::new()
            }
        }
    };
    let primary = fetch(OPENROUTER_URL, parse_openrouter, "openrouter");
    let secondary = fetch(LITELLM_URL, parse_litellm, "litellm");
    if primary.is_empty() && secondary.is_empty() {
        bail!(
            "both pricing sources unavailable: {}",
            items
                .iter()
                .map(|i| i.message.as_str())
                .collect::<Vec<_>>()
                .join("; ")
        );
    }
    store.refresh(references, &primary, &secondary, at, items)
}
