//! Reference-model rates in integer micro-USD per Mtok. Caching discounts are ignored.
//! History starts when rates are fetched, not at the upstream model release date.

use anyhow::{Context, Result, bail, ensure};
use factory_db::money::{MicroUsdPerMtok, NanoUsd, request_cost};
use regex::Regex;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path, time::Duration};

pub const OPENROUTER_URL: &str = "https://openrouter.ai/api/v1/models";
pub const LITELLM_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
pub const DEFAULT_CONFIG: &str = include_str!("../config/references.toml");

/// Public feeds require HTTPS; HTTP is allowed only for loopback fixtures.
pub fn feed_url(text: &str) -> Result<String> {
    let url = reqwest::Url::parse(text).context("feed URL must be an absolute http(s) URL")?;
    let host = url.host_str().context("feed URL must have a host")?;
    let loopback = host == "localhost"
        || host
            .trim_matches(['[', ']'])
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    ensure!(
        url.scheme() == "https" || (url.scheme() == "http" && loopback),
        "feed URL requires https unless the host is loopback (127.0.0.0/8, ::1, localhost)"
    );
    Ok(url.into())
}

/// Startup logs omit query strings, fragments and credentials.
pub fn feed_url_for_log(text: &str) -> String {
    let mut url = reqwest::Url::parse(text).expect("validated feed URL");
    url.set_query(None);
    url.set_fragment(None);
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.into()
}

/// Explicit offline migration only. Never adopt or convert legacy pricing data.
pub fn migrate(path: impl AsRef<Path>) -> Result<factory_db::migrations::Report> {
    let mut db = Connection::open(path)?;
    let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
    ensure!(
        version != 0 || factory_db::migrations::schema_fingerprint(&db)?.is_empty(),
        "legacy pricing DB found; move it aside first (the installer does this)"
    );
    migrate_connection(&mut db)
}

fn migrate_connection(db: &mut Connection) -> Result<factory_db::migrations::Report> {
    factory_db::migrations::run(
        db,
        &[factory_db::migrations::Migration {
            version: 1,
            sql: include_str!("v1.sql"),
            checksum: 0x0af2319c94ae0a5a,
        }],
        None,
        |_, _| Ok(()),
        |_, _| Ok(()),
    )
}

pub fn verify_version(db: &Connection) -> Result<()> {
    let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
    ensure!(
        version == 1,
        "pricing DB version {version}; expected v1. Run factory-api migrate --pricing-db <path>; move legacy DBs aside first (the installer does this)"
    );
    Ok(())
}

/// Check before pools apply writable settings or create a missing file.
pub fn verify_path(path: impl AsRef<Path>) -> Result<()> {
    let path = path.as_ref();
    let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| {
            format!(
                "pricing DB missing or unreadable: {}; run factory-api migrate --pricing-db {}",
                path.display(),
                path.display()
            )
        })?;
    verify_version(&db)
}

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
    pub input_micro_usd_per_mtok: i64,
    pub output_micro_usd_per_mtok: i64,
    pub released_at_ms: Option<i64>,
}

/// Exact decimal USD/token to micro-USD/Mtok (×10^12). Reject fractional micro-USD.
/// JSON's arbitrary_precision feature preserves numeric lexemes without f64.
pub fn parse_rate(text: &str) -> Result<i64> {
    ensure!(
        !text.starts_with('-') && text.trim() == text,
        "invalid token rate"
    );
    let _: serde_json::Number = serde_json::from_str(text).context("invalid token rate")?;
    let (mantissa, exponent) = match text.split_once(['e', 'E']) {
        Some((m, e)) => (m, e.parse::<i32>().context("rate exponent overflow")?),
        None => (text, 0),
    };
    let fraction = mantissa.split_once('.').map_or(0, |(_, f)| f.len());
    let digits = mantissa.replace('.', "");
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() {
        return Ok(0);
    }
    let shift = i64::from(exponent) + 12 - i64::try_from(fraction)?;
    let length = i64::try_from(digits.len())? + shift;
    ensure!(length <= 19, "token rate overflow");
    ensure!(length > 0, "token rate is below micro-USD/Mtok precision");
    let length = usize::try_from(length)?;
    ensure!(
        digits
            .get(length..)
            .is_none_or(|rest| rest.bytes().all(|d| d == b'0')),
        "token rate has fractional micro-USD/Mtok"
    );
    let mut integer = digits[..length.min(digits.len())].to_owned();
    integer.extend(std::iter::repeat_n(
        '0',
        length.saturating_sub(digits.len()),
    ));
    integer.parse::<i64>().context("token rate overflow")
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
                input_micro_usd_per_mtok: parse_rate(&entry.pricing.prompt)?,
                output_micro_usd_per_mtok: parse_rate(&entry.pricing.completion)?,
                released_at_ms: Some(
                    entry
                        .created
                        .checked_mul(1000)
                        .context("release timestamp overflow")?,
                ),
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
        input_cost_per_token: Option<serde_json::Number>,
        output_cost_per_token: Option<serde_json::Number>,
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
                input_micro_usd_per_mtok: parse_rate(&input.to_string())?,
                output_micro_usd_per_mtok: parse_rate(&output.to_string())?,
                released_at_ms: None,
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
        .filter(|m| m.released_at_ms.is_some() && pattern.is_match(&m.model_id))
        .max_by(|a, b| {
            a.released_at_ms
                .cmp(&b.released_at_ms)
                .then_with(|| b.model_id.cmp(&a.model_id))
        }))
}

/// Relative difference uses the primary (OpenRouter) rate as its denominator.
pub fn disagrees(primary: &Model, secondary: &Model) -> bool {
    [
        (
            primary.input_micro_usd_per_mtok,
            secondary.input_micro_usd_per_mtok,
        ),
        (
            primary.output_micro_usd_per_mtok,
            secondary.output_micro_usd_per_mtok,
        ),
    ]
    .into_iter()
    .any(|(a, b)| {
        i128::from(b) * 100 > i128::from(a) * 105 || i128::from(b) * 100 < i128::from(a) * 95
    })
}

#[derive(Clone, Debug, Serialize)]
pub struct Item {
    pub fetched_at_ms: i64,
    pub kind: String,
    pub family: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct Selection {
    pub model_id: String,
    pub effective_from_ms: i64,
}

#[derive(Debug, Serialize)]
pub struct Rates {
    pub fetched_at_ms: i64,
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
    rates: BTreeMap<String, Vec<(i64, i64, i64)>>,
    pub earliest: Option<(i64, i64)>,
}

impl History {
    pub fn rates_at(&self, at_ms: i64) -> Option<(i64, i64)> {
        let selected = self.selections.partition_point(|(time, _)| *time <= at_ms);
        let (_, model) = self.selections.get(selected.checked_sub(1)?)?;
        let rates = self.rates.get(model)?;
        let index = rates.partition_point(|(time, _, _)| *time <= at_ms);
        let (_, input, output) = rates.get(index.checked_sub(1)?)?;
        Some((*input, *output))
    }
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        verify_path(&path)?;
        let connection =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        factory_db::settings::apply(&connection, false, 65_536)?;
        Self::from_connection(connection)
    }

    /// Borrow the owned connection for shared settings, counters and snapshots.
    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    /// Use an existing connection without running schema migrations or taking a write lock.
    pub fn reader(connection: Connection) -> Result<Self> {
        let store = Self::from_connection(connection)?;
        store.connection.execute_batch("PRAGMA query_only=ON;")?;
        Ok(store)
    }

    /// Keep selections, rates, and warnings on one committed WAL snapshot.
    pub fn snapshot<T>(&self, read: impl FnOnce(&Self) -> Result<T>) -> Result<T> {
        let transaction = self.connection.unchecked_transaction()?;
        let value = read(self)?;
        transaction.commit()?;
        Ok(value)
    }

    pub fn in_memory() -> Result<Self> {
        let mut connection = Connection::open_in_memory()?;
        migrate_connection(&mut connection)?;
        factory_db::settings::apply(&connection, false, 65_536)?;
        Self::from_connection(connection)
    }

    /// Adopt an owner-configured connection, never change its schema at runtime.
    pub fn from_connection(connection: Connection) -> Result<Self> {
        verify_version(&connection)?;
        Ok(Self { connection })
    }

    /// Three queries per family, regardless of the number of token rows. Includes
    /// predecessor selections/rates and the original pre-history estimate.
    pub fn history(&self, family: &str, until_ms: i64) -> Result<History> {
        let selections = self
            .connection
            .prepare(
                "SELECT effective_from_ms,model_id FROM reference_selection
             WHERE family=?1 AND confirmed=1 AND effective_from_ms<=?2
             ORDER BY effective_from_ms,id",
            )?
            .query_map(params![family, until_ms], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut rates = BTreeMap::<String, Vec<(i64, i64, i64)>>::new();
        let mut statement = self.connection.prepare(
            "SELECT model_id,fetched_at_ms,input_micro_usd_per_mtok,output_micro_usd_per_mtok FROM price_snapshots INDEXED BY snapshot_lookup
             WHERE model_id IN (SELECT model_id FROM reference_selection WHERE family=?1 AND confirmed=1)
               AND fetched_at_ms<=?2
             ORDER BY model_id DESC,fetched_at_ms,refresh_id,(source='openrouter'),id",
        )?;
        for row in statement.query_map(params![family, until_ms], |r| {
            Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?)))
        })? {
            let (model, rate) = row?;
            rates.entry(model).or_default().push(rate);
        }
        let earliest = self.connection.query_row(
            "SELECT input_micro_usd_per_mtok,output_micro_usd_per_mtok FROM price_snapshots INDEXED BY snapshot_earliest
             WHERE model_id=(SELECT model_id FROM reference_selection WHERE family=?1 AND confirmed=1
                 ORDER BY effective_from_ms,id LIMIT 1)
             ORDER BY fetched_at_ms,refresh_id,(source='openrouter') DESC,id DESC LIMIT 1",
            [family], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        Ok(History {
            selections,
            rates,
            earliest,
        })
    }

    fn selected(&self, family: &str, at_ms: i64) -> Result<Option<Selection>> {
        Ok(self
            .connection
            .query_row(
                "SELECT model_id,effective_from_ms FROM reference_selection
             WHERE family=?1 AND confirmed=1 AND effective_from_ms<=?2
             ORDER BY effective_from_ms DESC,id DESC LIMIT 1",
                params![family, at_ms],
                |r| {
                    Ok(Selection {
                        model_id: r.get(0)?,
                        effective_from_ms: r.get(1)?,
                    })
                },
            )
            .optional()?)
    }

    fn pending(&self, family: &str) -> Result<Option<Selection>> {
        Ok(self
            .connection
            .query_row(
                "SELECT model_id,effective_from_ms FROM reference_selection INDEXED BY selection_pending
             WHERE family=?1 AND confirmed=0
               AND refresh_id = (SELECT MAX(id) FROM refreshes)
               AND id > COALESCE((SELECT MAX(id) FROM reference_selection INDEXED BY selection_confirmed_id
                                    WHERE family=?1 AND confirmed=1),0)
             ORDER BY effective_from_ms DESC,id DESC LIMIT 1",
                [family],
                |r| {
                    Ok(Selection {
                        model_id: r.get(0)?,
                        effective_from_ms: r.get(1)?,
                    })
                },
            )
            .optional()?)
    }

    fn rates(&self, model_id: &str, at_ms: i64) -> Result<Option<Rates>> {
        Ok(self
            .connection
            .query_row(
                "SELECT fetched_at_ms,source,input_micro_usd_per_mtok,output_micro_usd_per_mtok,released_at_ms
             FROM price_snapshots INDEXED BY snapshot_lookup WHERE model_id=?1 AND fetched_at_ms<=?2
             ORDER BY fetched_at_ms DESC,refresh_id DESC,(source='openrouter') DESC,id DESC LIMIT 1",
                params![model_id, at_ms],
                |r| {
                    Ok(Rates {
                        fetched_at_ms: r.get(0)?,
                        source: r.get(1)?,
                        model: Model {
                            model_id: model_id.into(),
                            input_micro_usd_per_mtok: r.get(2)?,
                            output_micro_usd_per_mtok: r.get(3)?,
                            released_at_ms: r.get(4)?,
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
        fetched_at_ms: i64,
        mut items: Vec<Item>,
    ) -> Result<Vec<Item>> {
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        ensure!(fetched_at_ms >= 0, "invalid fetch timestamp");
        let latest: Option<i64> = self.connection.query_row(
            "SELECT MAX(effective_from_ms) FROM reference_selection",
            [],
            |r| r.get(0),
        )?;
        let latest_fetch: Option<i64> =
            self.connection
                .query_row("SELECT MAX(fetched_at_ms) FROM refreshes", [], |r| r.get(0))?;
        ensure!(
            latest
                .into_iter()
                .chain(latest_fetch)
                .all(|t| fetched_at_ms >= t),
            "fetch timestamp predates history"
        );
        ensure!(
            !primary.is_empty() || !secondary.is_empty(),
            "no usable source models"
        );
        let releases = self
            .connection
            .prepare(
                "SELECT model_id,MAX(released_at_ms) FROM price_snapshots
             WHERE model_id IN (SELECT value FROM json_each(?1)) GROUP BY model_id",
            )?
            .query_map(
                [serde_json::to_string(
                    &secondary.iter().map(|m| &m.model_id).collect::<Vec<_>>(),
                )?],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?)),
            )?
            .collect::<rusqlite::Result<BTreeMap<_, _>>>()?;
        let mut secondary = secondary.to_vec();
        for model in &mut secondary {
            model.released_at_ms = primary
                .iter()
                .find(|p| p.model_id == model.model_id)
                .and_then(|p| p.released_at_ms)
                .or_else(|| releases.get(&model.model_id).copied().flatten());
        }
        let candidates = if primary.is_empty() {
            &secondary
        } else {
            primary
        };
        let mut pending = Vec::new();
        for reference in references {
            let confirmed = self.selected(&reference.name, fetched_at_ms)?;
            let resolved = resolve(reference, candidates)?;
            if let Some(model) = resolved {
                if confirmed
                    .as_ref()
                    .is_none_or(|s| s.model_id != model.model_id)
                {
                    pending.push((&reference.name, &model.model_id));
                    items.push(Item {
                        fetched_at_ms,
                        kind: "pricing.changed".into(),
                        family: reference.name.clone(),
                        message: format!("pending {}; confirmation required", model.model_id),
                    });
                }
            } else {
                items.push(Item {
                    fetched_at_ms,
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
                        "{id}: rates disagree >5%; OpenRouter {}/{} vs LiteLLM {}/{} micro-USD per Mtok (input/output)",
                        a.input_micro_usd_per_mtok,
                        a.output_micro_usd_per_mtok,
                        b.input_micro_usd_per_mtok,
                        b.output_micro_usd_per_mtok
                    )),
                    (None, _) | (_, None) => Some(format!(
                        "{id}: cross-check unavailable; model missing from a source"
                    )),
                    _ => None,
                };
                if let Some(message) = message {
                    items.push(Item {
                        fetched_at_ms,
                        kind: "warning".into(),
                        family: reference.name.clone(),
                        message,
                    });
                }
            }
        }
        transaction.execute(
            "INSERT INTO refreshes(fetched_at_ms) VALUES (?1)",
            [fetched_at_ms],
        )?;
        let refresh_id = transaction.last_insert_rowid();
        let mut snapshots = Vec::new();
        for (source, models) in [("openrouter", primary), ("litellm", secondary.as_slice())] {
            for model in models {
                MicroUsdPerMtok::new(model.input_micro_usd_per_mtok)?;
                MicroUsdPerMtok::new(model.output_micro_usd_per_mtok)?;
                ensure!(
                    model.released_at_ms.is_none_or(|t| t >= 0),
                    "invalid release timestamp"
                );
                snapshots.push([
                    fetched_at_ms.into(),
                    source.to_owned().into(),
                    model.model_id.clone().into(),
                    model.input_micro_usd_per_mtok.into(),
                    model.output_micro_usd_per_mtok.into(),
                    model.released_at_ms.into(),
                    refresh_id.into(),
                ]);
            }
        }
        insert_batches(
            &transaction,
            "price_snapshots(fetched_at_ms,source,model_id,input_micro_usd_per_mtok,output_micro_usd_per_mtok,released_at_ms,refresh_id)",
            &snapshots,
        )?;
        let pending: Vec<_> = pending
            .into_iter()
            .map(|(family, id)| {
                [
                    family.clone().into(),
                    id.clone().into(),
                    fetched_at_ms.into(),
                    0.into(),
                    refresh_id.into(),
                ]
            })
            .collect();
        insert_batches(
            &transaction,
            "reference_selection(family,model_id,effective_from_ms,confirmed,refresh_id)",
            &pending,
        )?;
        let rows: Vec<_> = items
            .iter()
            .map(|item| {
                [
                    item.fetched_at_ms.into(),
                    item.kind.clone().into(),
                    item.family.clone().into(),
                    item.message.clone().into(),
                    refresh_id.into(),
                ]
            })
            .collect();
        insert_batches(
            &transaction,
            "pricing_items(fetched_at_ms,kind,family,message,refresh_id)",
            &rows,
        )?;
        transaction.commit()?;
        Ok(items)
    }

    pub fn confirm(&mut self, family: &str, at_ms: i64) -> Result<Selection> {
        // Lock before reading the candidate so another process cannot refresh it
        // between lookup and confirmation.
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let pending = self
            .pending(family)?
            .context("no pending change for this family")?;
        let latest: Option<i64> = transaction.query_row(
            "SELECT MAX(effective_from_ms) FROM reference_selection",
            [],
            |r| r.get(0),
        )?;
        ensure!(
            at_ms >= pending.effective_from_ms && latest.is_none_or(|t| at_ms >= t),
            "confirmation predates pending change"
        );
        transaction.execute(
                "INSERT INTO reference_selection(family,model_id,effective_from_ms,confirmed,refresh_id) VALUES (?1,?2,?3,1,(SELECT MAX(id) FROM refreshes))",
                params![family, pending.model_id, at_ms],
            )?;
        transaction.commit()?;
        Ok(Selection {
            model_id: pending.model_id,
            effective_from_ms: at_ms,
        })
    }

    /// Price tokens using the confirmed model and latest observed rates AT `at_ms`.
    /// No future observations, caching discounts, long-context tiers, tools,
    /// images, or audio charges are included. Round once to nano-USD per request.
    pub fn cost(
        &self,
        family: &str,
        prompt_tokens: u64,
        output_tokens: u64,
        at_ms: i64,
    ) -> Result<NanoUsd> {
        let selected = self
            .selected(family, at_ms)?
            .context("no confirmed selection at this timestamp")?;
        let rates = self
            .rates(&selected.model_id, at_ms)?
            .context("no rates at this timestamp")?;
        request_cost(
            prompt_tokens,
            output_tokens,
            MicroUsdPerMtok(rates.model.input_micro_usd_per_mtok),
            MicroUsdPerMtok(rates.model.output_micro_usd_per_mtok),
        )
    }

    pub fn show(&self, references: &[Reference], at_ms: i64) -> Result<Vec<FamilyStatus>> {
        references
            .iter()
            .map(|reference| {
                let selected = self.selected(&reference.name, at_ms)?;
                let rates = selected
                    .as_ref()
                    .map(|s| self.rates(&s.model_id, at_ms))
                    .transpose()?
                    .flatten();
                let pending = self.pending(&reference.name)?;
                let pending_rates = pending
                    .as_ref()
                    .map(|s| self.rates(&s.model_id, at_ms))
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
            "SELECT fetched_at_ms,kind,family,message FROM pricing_items
             WHERE refresh_id=(SELECT MAX(id) FROM refreshes) ORDER BY id",
        )?;
        Ok(statement
            .query_map([], |r| {
                Ok(Item {
                    fetched_at_ms: r.get(0)?,
                    kind: r.get(1)?,
                    family: r.get(2)?,
                    message: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

/// All three refresh writes share the same bounded 100-row insert policy.
fn insert_batches<const N: usize>(
    db: &Connection,
    columns: &str,
    rows: &[[rusqlite::types::Value; N]],
) -> Result<()> {
    let tuple = format!(
        "({})",
        std::iter::repeat_n("?", N).collect::<Vec<_>>().join(",")
    );
    for chunk in rows.chunks(100) {
        let values = std::iter::repeat_n(tuple.as_str(), chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        db.execute(
            &format!("INSERT INTO {columns} VALUES {values}"),
            rusqlite::params_from_iter(chunk.iter().flatten()),
        )?;
    }
    Ok(())
}

/// Fetch both feeds independently. One failure is a recorded warning; both failing
/// aborts without changing the database. OpenRouter is authoritative when present.
pub fn fetch_live(at_ms: i64) -> Result<(Vec<Model>, Vec<Model>, Vec<Item>)> {
    fetch_from(at_ms, OPENROUTER_URL, LITELLM_URL)
}

/// Fetch from configured feed URLs, using the same parsers and fallback rules.
pub fn fetch_from(
    at_ms: i64,
    openrouter: &str,
    litellm: &str,
) -> Result<(Vec<Model>, Vec<Model>, Vec<Item>)> {
    let openrouter = feed_url(openrouter)?;
    let litellm = feed_url(litellm)?;
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
                    fetched_at_ms: at_ms,
                    kind: "warning".into(),
                    family: "*".into(),
                    message: format!("{source} unavailable: {error:#}"),
                });
                Vec::new()
            }
        }
    };
    let primary = fetch(&openrouter, parse_openrouter, "openrouter");
    let secondary = fetch(&litellm, parse_litellm, "litellm");
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
    Ok((primary, secondary, items))
}
