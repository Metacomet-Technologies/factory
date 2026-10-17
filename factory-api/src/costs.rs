//! Frozen per-request reference costs (MET-204, docs/data-model.md).
//!
//! Pricing history is immutable and append-only, so the API reads it in one
//! pricing snapshot and then freezes classifications in its own transaction.
//! Selection and rate are chosen at the request's event time, never at the
//! time it is priced. Priced and estimated rows are never rewritten; the only
//! transition is unpriced -> estimated once a reference price exists.
use crate::INFERENCE_ENDPOINTS;
use anyhow::{Context, Result, anyhow};
use factory_db::money::{MicroUsdPerMtok, request_cost};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use shared::RequestRecord;
use std::collections::BTreeMap;

/// Ascending request IDs per backfill transaction, as for meter replay.
pub const PAGE: usize = 500;
/// Pages per poll before yielding until the next collector tick.
pub const PAGES_PER_POLL: usize = 20;
/// Cost rows per INSERT: 100 requests for each of today's two families.
const INSERT_ROWS: usize = 200;

pub fn families() -> Result<Vec<String>> {
    Ok(pricing::parse_references(pricing::DEFAULT_CONFIG)?
        .into_iter()
        .map(|r| r.name)
        .collect())
}

pub fn inference(endpoint: &str) -> bool {
    INFERENCE_ENDPOINTS.contains(&endpoint)
}

/// The pricing rows a classification was derived from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Provenance {
    pub selection_id: i64,
    pub snapshot_id: i64,
    pub model_id: String,
    pub input_micro_usd_per_mtok: i64,
    pub output_micro_usd_per_mtok: i64,
}

/// One family's confirmed selections and their observed rates, loaded once.
#[derive(Debug)]
pub struct History {
    pub family: String,
    /// (effective_from_ms, selection id, model), ascending.
    selections: Vec<(i64, i64, String)>,
    /// model -> (fetched_at_ms, snapshot id, input, output), in pricing's tie order.
    rates: BTreeMap<String, Vec<(i64, i64, i64, i64)>>,
    /// Earliest observed rate of the earliest confirmed selection.
    pub earliest: Option<Provenance>,
}

impl History {
    /// Three statements, regardless of the number of requests. Mirrors
    /// pricing::Store::history, adding the selection and snapshot IDs.
    pub fn load(store: &pricing::Store, family: &str) -> Result<Self> {
        let db = store.connection();
        let selections = db
            .prepare(
                "SELECT effective_from_ms,id,model_id FROM reference_selection
                 WHERE family=?1 AND confirmed=1 ORDER BY effective_from_ms,id",
            )?
            .query_map([family], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut rates = BTreeMap::<String, Vec<_>>::new();
        let mut statement = db.prepare(
            "SELECT model_id,fetched_at_ms,id,input_micro_usd_per_mtok,output_micro_usd_per_mtok
             FROM price_snapshots INDEXED BY snapshot_lookup
             WHERE model_id IN (SELECT model_id FROM reference_selection WHERE family=?1 AND confirmed=1)
             ORDER BY model_id DESC,fetched_at_ms,refresh_id,(source='openrouter'),id",
        )?;
        for row in statement.query_map([family], |r| {
            Ok((
                r.get::<_, String>(0)?,
                (r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?),
            ))
        })? {
            let (model, rate) = row?;
            rates.entry(model).or_default().push(rate);
        }
        let earliest = db
            .query_row(
                "SELECT (SELECT id FROM reference_selection WHERE family=?1 AND confirmed=1
                         ORDER BY effective_from_ms,id LIMIT 1),
                        model_id,id,input_micro_usd_per_mtok,output_micro_usd_per_mtok
                 FROM price_snapshots INDEXED BY snapshot_earliest
                 WHERE model_id=(SELECT model_id FROM reference_selection WHERE family=?1 AND confirmed=1
                     ORDER BY effective_from_ms,id LIMIT 1)
                 ORDER BY fetched_at_ms,refresh_id,(source='openrouter') DESC,id DESC LIMIT 1",
                [family],
                |r| {
                    Ok(Provenance {
                        selection_id: r.get(0)?,
                        model_id: r.get(1)?,
                        snapshot_id: r.get(2)?,
                        input_micro_usd_per_mtok: r.get(3)?,
                        output_micro_usd_per_mtok: r.get(4)?,
                    })
                },
            )
            .optional()?;
        Ok(Self {
            family: family.into(),
            selections,
            rates,
            earliest,
        })
    }

    /// Selection and rate in effect at `at_ms`: the latest of each at or before it.
    pub fn at(&self, at_ms: i64) -> Option<Provenance> {
        let index = self.selections.partition_point(|(t, _, _)| *t <= at_ms);
        let (_, selection_id, model_id) = self.selections.get(index.checked_sub(1)?)?;
        let rates = self.rates.get(model_id)?;
        let index = rates.partition_point(|(t, _, _, _)| *t <= at_ms);
        let (_, snapshot_id, input, output) = rates.get(index.checked_sub(1)?)?;
        Some(Provenance {
            selection_id: *selection_id,
            snapshot_id: *snapshot_id,
            model_id: model_id.clone(),
            input_micro_usd_per_mtok: *input,
            output_micro_usd_per_mtok: *output,
        })
    }
}

/// Load every configured family. Pool readers already run each job in one
/// read transaction, so all families share one pricing snapshot.
pub fn load(store: &pricing::Store, families: &[String]) -> Result<Vec<History>> {
    families.iter().map(|f| History::load(store, f)).collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Priced,
    Estimated,
    Unpriced,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Priced => "priced",
            Self::Estimated => "estimated",
            Self::Unpriced => "unpriced",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cost {
    pub request_id: i64,
    pub family: String,
    pub status: Status,
    pub nano_usd: Option<i64>,
    pub provenance: Option<Provenance>,
    /// Unpriced only because no reference price existed yet.
    pub awaiting_price: bool,
}

/// Missing tokens are unpriced; zero tokens are a real, zero-cost classification.
pub fn classify(
    history: &History,
    request_id: i64,
    ts_ms: i64,
    prompt_tokens: Option<u64>,
    output_tokens: Option<u64>,
) -> Result<Cost> {
    let mut cost = Cost {
        request_id,
        family: history.family.clone(),
        status: Status::Unpriced,
        nano_usd: None,
        provenance: None,
        awaiting_price: false,
    };
    let (Some(prompt), Some(output)) = (prompt_tokens, output_tokens) else {
        return Ok(cost);
    };
    let (status, provenance) = match history.at(ts_ms) {
        Some(p) => (Status::Priced, p),
        None => match &history.earliest {
            Some(p) => (Status::Estimated, p.clone()),
            None => {
                cost.awaiting_price = true;
                return Ok(cost);
            }
        },
    };
    let nano = request_cost(
        prompt,
        output,
        MicroUsdPerMtok::new(provenance.input_micro_usd_per_mtok)?,
        MicroUsdPerMtok::new(provenance.output_micro_usd_per_mtok)?,
    )
    .with_context(|| format!("request {request_id} {} cost", history.family))?;
    cost.status = status;
    cost.nano_usd = Some(nano.0);
    cost.provenance = Some(provenance);
    Ok(cost)
}

/// Classify a meter page in ID order. On the first failure, keep only the
/// records before that request so ingestion never skips past it.
pub fn freeze(
    histories: &Result<Vec<History>>,
    records: &mut Vec<RequestRecord>,
) -> (Vec<Cost>, Option<anyhow::Error>) {
    let mut costs = Vec::new();
    for (index, record) in records.iter().enumerate() {
        if !inference(&record.endpoint) {
            continue;
        }
        let result = match histories {
            Ok(histories) => histories
                .iter()
                .map(|h| {
                    classify(
                        h,
                        record.id,
                        record.ts,
                        record.prompt_eval_count,
                        record.eval_count,
                    )
                })
                .collect::<Result<Vec<_>>>(),
            Err(error) => Err(anyhow!("pricing history unavailable: {error:#}")),
        };
        match result {
            Ok(classified) => costs.extend(classified),
            Err(error) => {
                let id = record.id;
                records.truncate(index);
                return (
                    costs,
                    Some(anyhow!(
                        "cost freeze stopped at meter id {id}; ingestion paused: {error:#}"
                    )),
                );
            }
        }
    }
    (costs, None)
}

/// Insert classifications. Existing rows are kept, except unpriced -> estimated,
/// so a retried upsert never reprices a frozen row.
pub fn store(db: &Connection, costs: &[Cost], priced_at_ms: i64) -> Result<()> {
    for chunk in costs.chunks(INSERT_ROWS) {
        let values = std::iter::repeat_n("(?,?,?,?,?,?,?,?,?,?)", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let mut parameters = Vec::<rusqlite::types::Value>::with_capacity(chunk.len() * 10);
        for c in chunk {
            let p = c.provenance.as_ref();
            parameters.extend([
                c.request_id.into(),
                c.family.clone().into(),
                priced_at_ms.into(),
                c.status.as_str().to_owned().into(),
                c.nano_usd.into(),
                p.map(|p| p.selection_id).into(),
                p.map(|p| p.snapshot_id).into(),
                p.map(|p| p.model_id.clone()).into(),
                p.map(|p| p.input_micro_usd_per_mtok).into(),
                p.map(|p| p.output_micro_usd_per_mtok).into(),
            ]);
        }
        db.execute(
            &format!(
                "INSERT INTO request_costs(request_id,family,priced_at_ms,cost_status,cost_nano_usd,selection_id,snapshot_id,reference_model_id,input_micro_usd_per_mtok,output_micro_usd_per_mtok)
                 VALUES {values}
                 ON CONFLICT(request_id,family) DO UPDATE SET priced_at_ms=excluded.priced_at_ms,
                   cost_status=excluded.cost_status,cost_nano_usd=excluded.cost_nano_usd,
                   selection_id=excluded.selection_id,snapshot_id=excluded.snapshot_id,
                   reference_model_id=excluded.reference_model_id,
                   input_micro_usd_per_mtok=excluded.input_micro_usd_per_mtok,
                   output_micro_usd_per_mtok=excluded.output_micro_usd_per_mtok
                 WHERE request_costs.cost_status='unpriced' AND excluded.cost_status='estimated'"
            ),
            rusqlite::params_from_iter(parameters),
        )?;
    }
    let mut awaiting = BTreeMap::<&str, i64>::new();
    for c in costs.iter().filter(|c| c.awaiting_price) {
        let first = awaiting.entry(&c.family).or_insert(c.request_id);
        *first = (*first).min(c.request_id);
    }
    for (family, first) in awaiting {
        db.execute(
            "UPDATE cost_backfill SET unpriced_from_id=MIN(COALESCE(unpriced_from_id,?2),?2) WHERE family=?1",
            params![family, first],
        )?;
    }
    Ok(())
}

/// Seed one walk per configured family over every request present now. Rows
/// that arrive later are frozen at ingestion, so an empty cache is complete.
pub fn seed(db: &Connection, families: &[String], now_ms: i64) -> Result<()> {
    for family in families {
        db.execute(
            "INSERT OR IGNORE INTO cost_backfill(family,after_id,target_id,completed_at_ms)
             SELECT ?1,0,COALESCE(MAX(id),0),CASE WHEN MAX(id) IS NULL THEN ?2 END FROM requests",
            params![family, now_ms],
        )?;
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    pub family: String,
    pub after_id: i64,
    pub target_id: i64,
    pub unpriced_from_id: Option<i64>,
    pub completed_at_ms: Option<i64>,
}

pub fn states(db: &Connection) -> Result<Vec<State>> {
    Ok(db
        .prepare(
            "SELECT family,after_id,target_id,unpriced_from_id,completed_at_ms FROM cost_backfill",
        )?
        .query_map([], |r| {
            Ok(State {
                family: r.get(0)?,
                after_id: r.get(1)?,
                target_id: r.get(2)?,
                unpriced_from_id: r.get(3)?,
                completed_at_ms: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// Nothing to do: every configured family is complete with no pending fill-in.
pub fn idle(states: &[State], families: &[String]) -> bool {
    families.iter().all(|family| {
        states.iter().any(|s| {
            &s.family == family
                && s.completed_at_ms.is_some()
                && s.after_id >= s.target_id
                && s.unpriced_from_id.is_none()
        })
    })
}

/// One backfill transaction of at most PAGE requests. Returns whether more
/// work remains. A classification failure commits the requests before it,
/// leaves the cursor before the failing request, and returns the error.
pub fn backfill_page(db: &mut Connection, histories: &[History], now_ms: i64) -> Result<bool> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let families: Vec<String> = histories.iter().map(|h| h.family.clone()).collect();
    let mut states = states(&tx)?;
    if families
        .iter()
        .any(|f| !states.iter().any(|s| &s.family == f))
    {
        seed(&tx, &families, now_ms)?;
        states = self::states(&tx)?;
    }
    // A reference price now exists: walk again from the first row frozen before it.
    for history in histories.iter().filter(|h| h.earliest.is_some()) {
        if let Some(state) = states.iter_mut().find(|s| s.family == history.family)
            && let Some(first) = state.unpriced_from_id.take()
        {
            (state.after_id, state.target_id) = tx.query_row(
                "UPDATE cost_backfill SET after_id=MIN(after_id,?2-1),
                   target_id=MAX(target_id,(SELECT COALESCE(MAX(id),0) FROM requests)),
                   unpriced_from_id=NULL WHERE family=?1 RETURNING after_id,target_id",
                params![state.family, first],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
        }
    }
    let active: Vec<(&History, &State)> = histories
        .iter()
        .filter_map(|h| {
            let state = states.iter().find(|s| s.family == h.family)?;
            (state.after_id < state.target_id).then_some((h, state))
        })
        .collect();
    if active.is_empty() {
        for state in states
            .iter()
            .filter(|s| s.completed_at_ms.is_none() && families.contains(&s.family))
        {
            verify(&tx, &state.family)?;
            tx.execute(
                "UPDATE cost_backfill SET completed_at_ms=?2 WHERE family=?1",
                params![state.family, now_ms],
            )?;
        }
        tx.commit()?;
        return Ok(false);
    }
    let low = active.iter().map(|(_, s)| s.after_id).min().unwrap_or(0);
    let high = active.iter().map(|(_, s)| s.target_id).max().unwrap_or(0);
    // Each row carries the rollup checkpoint, so the page stays one statement.
    let mut rolled = 0;
    let rows = tx
        .prepare(
            "SELECT id,ts_ms,endpoint,prompt_eval_count,eval_count,
               COALESCE((SELECT last_id FROM rollup_state WHERE job='requests'),0)
             FROM requests WHERE id>?1 AND id<=?2 ORDER BY id LIMIT ?3",
        )?
        .query_map(params![low, high, PAGE as i64], |r| {
            Ok((
                (
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                ),
                r.get::<_, i64>(5)?,
            ))
        })?
        .map(|row| {
            row.map(|(row, last)| {
                rolled = last;
                row
            })
        })
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut end = if rows.len() < PAGE {
        high
    } else {
        rows.last().map_or(high, |r| r.0)
    };
    let mut costs = Vec::new();
    let mut failure = None;
    'rows: for (id, ts, endpoint, prompt, output) in &rows {
        if !inference(endpoint) {
            continue;
        }
        let mut classified = Vec::new();
        for (history, state) in &active {
            if *id <= state.after_id || *id > state.target_id {
                continue;
            }
            let result = (|| {
                classify(
                    history,
                    *id,
                    *ts,
                    prompt.map(u64::try_from).transpose()?,
                    output.map(u64::try_from).transpose()?,
                )
            })();
            match result {
                Ok(cost) => classified.push(cost),
                Err(error) => {
                    end = id - 1;
                    failure = Some(error.context(format!(
                        "cost backfill stopped at request id {id}; progress paused"
                    )));
                    break 'rows;
                }
            }
        }
        costs.extend(classified);
    }
    // Requests already in the rollups: their spend buckets change in this same
    // transaction (unpriced -> estimated fill-ins, or a newly added family).
    let before = if rolled > low && !costs.is_empty() {
        crate::rollups::existing(&tx, low, end.min(rolled))?
    } else {
        Default::default()
    };
    store(&tx, &costs, now_ms)?;
    if rolled > low && !costs.is_empty() {
        let days: BTreeMap<i64, i64> = rows.iter().map(|r| (r.0, r.1)).collect();
        crate::rollups::Rewrite::new(&costs, &before, rolled, &days).apply(&tx)?;
    }
    for (_, state) in &active {
        tx.execute(
            "UPDATE cost_backfill SET after_id=MAX(after_id,MIN(target_id,?2)) WHERE family=?1",
            params![state.family, end],
        )?;
    }
    tx.commit()?;
    match failure {
        Some(error) => Err(error),
        None => Ok(true),
    }
}

/// Before publishing completion: exactly one classification per inference
/// request for this family and none for other endpoints. A one-time full walk
/// of requests, like a migration scan; each row is a primary-key probe.
fn verify(db: &Connection, family: &str) -> Result<()> {
    let endpoints = INFERENCE_ENDPOINTS.map(|e| format!("'{e}'")).join(",");
    let wrong: i64 = db.query_row(
        &format!(
            "SELECT COUNT(*) FROM requests r LEFT JOIN request_costs c ON c.request_id=r.id AND c.family=?1
             WHERE (r.endpoint IN ({endpoints})) <> (c.request_id IS NOT NULL)"
        ),
        [family],
        |r| r.get(0),
    )?;
    anyhow::ensure!(
        wrong == 0,
        "cost backfill verification failed for {family}: {wrong} requests lack exactly one classification"
    );
    Ok(())
}
