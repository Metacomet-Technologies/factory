//! API request and spend rollups (MET-205, docs/data-model.md). One checkpoint
//! covers request metrics and frozen costs together: a batch never passes a
//! request whose family classifications are still being backfilled, and each
//! batch commits its aggregates with the checkpoint.
use crate::{INFERENCE_ENDPOINTS, costs};
use anyhow::{Context, Result, ensure};
use factory_db::rollup::{self, DAY_MS, HOUR_MS, Tps};
use rusqlite::{Connection, TransactionBehavior, params, params_from_iter};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

pub const TPS: Tps = Tps::Api;
pub const JOB: &str = "requests";
/// Batches per run; the next five-minute run resumes from the checkpoint.
pub const BATCHES_PER_RUN: usize = 20;

pub fn inference_list() -> String {
    INFERENCE_ENDPOINTS.map(|e| format!("'{e}'")).join(",")
}

const SPEND: [&str; 5] = [
    "priced_nano_usd",
    "estimated_nano_usd",
    "priced_requests",
    "estimated_requests",
    "unpriced_requests",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// Aggregated this many rows.
    Rolled(usize),
    /// No rows above the checkpoint; published the verified state if needed.
    CaughtUp,
    /// Rows remain, but their costs are still being classified.
    WaitingForCosts,
}

/// Highest ID whose inference requests have every configured classification.
fn classified_through(db: &Connection) -> Result<i64> {
    let states = costs::states(db)?;
    Ok(costs::families()?
        .iter()
        .map(|family| {
            states.iter().find(|s| &s.family == family).map_or(0, |s| {
                if s.after_id < s.target_id {
                    s.after_id
                } else {
                    i64::MAX
                }
            })
        })
        .min()
        .unwrap_or(i64::MAX))
}

/// Add frozen costs of requests in (after, through] to hourly spend rows.
fn add_spend(db: &Connection, after: i64, through: i64) -> Result<()> {
    db.prepare_cached(&format!(
        "INSERT INTO spend_hourly(bucket_ms,family,dimension_key,endpoint,model,user_key,actor_kind,{c})
         SELECT r.ts_ms-r.ts_ms%{HOUR_MS},c.family,json_array(r.endpoint,r.model,r.user_key,r.actor_kind),
           r.endpoint,r.model,r.user_key,r.actor_kind,
           COALESCE(SUM(CASE WHEN c.cost_status='priced' THEN c.cost_nano_usd END),0),
           COALESCE(SUM(CASE WHEN c.cost_status='estimated' THEN c.cost_nano_usd END),0),
           SUM(c.cost_status='priced'),SUM(c.cost_status='estimated'),SUM(c.cost_status='unpriced')
         FROM requests r JOIN request_costs c ON c.request_id=r.id
         WHERE r.id>?1 AND r.id<=?2 GROUP BY 1,2,3
         ON CONFLICT(bucket_ms,family,dimension_key) DO UPDATE SET {u}",
        c = SPEND.join(","),
        u = SPEND.map(|c| format!("{c}={c}+excluded.{c}")).join(",")
    ))?
    .execute(params![after, through])?;
    Ok(())
}

/// Replace each listed day's spend rows with sums of its hours.
pub fn recompute_spend_days(db: &Connection, days: &BTreeSet<i64>) -> Result<()> {
    let days: Vec<i64> = days.iter().copied().collect();
    for chunk in days.chunks(30_000) {
        let (cte, values) = rollup::days_cte(chunk);
        db.prepare_cached(&format!(
            "{cte} INSERT INTO spend_daily(bucket_ms,family,dimension_key,endpoint,model,user_key,actor_kind,{c})
             SELECT d.day,h.family,h.dimension_key,h.endpoint,h.model,h.user_key,h.actor_kind,{s}
             FROM d JOIN spend_hourly h ON h.bucket_ms>=d.day AND h.bucket_ms<d.day+{DAY_MS}
             WHERE true GROUP BY d.day,h.family,h.dimension_key
             ON CONFLICT(bucket_ms,family,dimension_key) DO UPDATE SET {u}",
            c = SPEND.join(","),
            s = SPEND.map(|c| format!("SUM(h.{c})")).join(","),
            u = SPEND.map(|c| format!("{c}=excluded.{c}")).join(",")
        ))?
        .execute(params_from_iter(values))?;
    }
    Ok(())
}

/// One batch of at most 5,000 requests, or the one-time verification.
pub fn batch(db: &mut Connection, now_ms: i64) -> Result<Step> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let state = rollup::state(&tx, JOB)?;
    let last = state.as_ref().map_or(0, |s| s.last_id);
    let through = classified_through(&tx)?;
    let rows = rollup::batch(&tx, last, through)?;
    if rows.is_empty() {
        if through < i64::MAX {
            let pending: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM requests WHERE id>?1)",
                [last],
                |r| r.get(0),
            )?;
            if pending {
                return Ok(Step::WaitingForCosts);
            }
        }
        if state.as_ref().is_none_or(|s| s.verified_at_ms.is_none()) {
            rollup::advance(&tx, JOB, last, now_ms)?;
            verify(&tx, last).context("request rollup verification")?;
            rollup::mark_verified(&tx, JOB, now_ms)?;
        }
        tx.commit()?;
        return Ok(Step::CaughtUp);
    }
    let end = rows.last().unwrap().id;
    let days = rollup::apply(&tx, &rows, TPS)?;
    add_spend(&tx, last, end)?;
    recompute_spend_days(&tx, &days)?;
    rollup::advance(&tx, JOB, end, now_ms)?;
    tx.commit()?;
    Ok(Step::Rolled(rows.len()))
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct Progress {
    pub batches: usize,
    pub rows: usize,
    pub caught_up: bool,
    pub waiting_for_costs: bool,
    pub verified: bool,
}

pub fn run(db: &mut Connection, now_ms: i64, batches: usize) -> Result<Progress> {
    let mut progress = Progress::default();
    for _ in 0..batches {
        match batch(db, now_ms)? {
            Step::Rolled(rows) => {
                progress.batches += 1;
                progress.rows += rows;
            }
            Step::CaughtUp => {
                progress.caught_up = true;
                break;
            }
            Step::WaitingForCosts => {
                progress.waiting_for_costs = true;
                break;
            }
        }
    }
    progress.verified = rollup::state(db, JOB)?.is_some_and(|s| s.verified_at_ms.is_some());
    Ok(progress)
}

/// Per-family totals by cost status, from raw classifications and from rollups.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct FamilyTotals {
    pub priced_nano_usd: i64,
    pub estimated_nano_usd: i64,
    pub unpriced_nano_usd: i64,
    pub priced_requests: i64,
    pub estimated_requests: i64,
    pub unpriced_requests: i64,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct Verified {
    pub raw_requests: i64,
    pub hourly_rows: usize,
    pub daily_rows: usize,
    pub dimension_keys: usize,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub input_known: i64,
    pub output_known: i64,
    pub spend_hourly_rows: usize,
    pub spend_daily_rows: usize,
    /// Raw `request_costs` sums; the rollups matched them exactly.
    pub families: BTreeMap<String, FamilyTotals>,
}

type SpendKey = (i64, String, rollup::Dim);

fn add_to(sum: &mut [i64; 5], values: [i64; 5]) -> Result<()> {
    for (s, v) in sum.iter_mut().zip(values) {
        *s = s.checked_add(v).context("spend sum overflow")?;
    }
    Ok(())
}

fn read_spend(db: &Connection, table: &str) -> Result<BTreeMap<SpendKey, [i64; 5]>> {
    let mut result = BTreeMap::new();
    let mut statement = db.prepare(&format!(
        "SELECT bucket_ms,family,endpoint,model,user_key,actor_kind,{} FROM {table}",
        SPEND.join(",")
    ))?;
    let mut rows = statement.query([])?;
    while let Some(r) = rows.next()? {
        let dim = rollup::Dim {
            endpoint: r.get(2)?,
            model: r.get(3)?,
            user_key: r.get(4)?,
            actor_kind: r.get(5)?,
        };
        let values = [r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?];
        result.insert((r.get(0)?, r.get(1)?, dim), values);
    }
    Ok(result)
}

/// One-time comparison before publishing (the reviewed migration-scan
/// exception): request rollups against raw rows, spend rollups against
/// `request_costs` per bucket, family, dimension and status, and the
/// priced+estimated+unpriced = inference requests invariant per family.
pub fn verify(db: &Connection, last_id: i64) -> Result<Verified> {
    let requests = rollup::verify(db, last_id, TPS)?;
    let mut hours = BTreeMap::<SpendKey, [i64; 5]>::new();
    let mut days = BTreeMap::<SpendKey, [i64; 5]>::new();
    let mut families = BTreeMap::<String, FamilyTotals>::new();
    let mut statement = db.prepare(
        "SELECT r.ts_ms,r.endpoint,r.model,r.user_key,r.actor_kind,c.family,c.cost_status,c.cost_nano_usd
         FROM requests r JOIN request_costs c ON c.request_id=r.id WHERE r.id<=?1",
    )?;
    let mut rows = statement.query([last_id])?;
    while let Some(r) = rows.next()? {
        let ts: i64 = r.get(0)?;
        let dim = rollup::Dim {
            endpoint: r.get(1)?,
            model: r.get(2)?,
            user_key: r.get(3)?,
            actor_kind: r.get(4)?,
        };
        let family: String = r.get(5)?;
        let status: String = r.get(6)?;
        let nano: Option<i64> = r.get(7)?;
        let totals = families.entry(family.clone()).or_default();
        let (count, sum) = match status.as_str() {
            "priced" => (&mut totals.priced_requests, &mut totals.priced_nano_usd),
            "estimated" => (
                &mut totals.estimated_requests,
                &mut totals.estimated_nano_usd,
            ),
            _ => (&mut totals.unpriced_requests, &mut totals.unpriced_nano_usd),
        };
        *count += 1;
        *sum = sum
            .checked_add(nano.unwrap_or(0))
            .context("cost sum overflow")?;
        let n = nano.unwrap_or(0);
        let values = match status.as_str() {
            "priced" => [n, 0, 1, 0, 0],
            "estimated" => [0, n, 0, 1, 0],
            _ => [0, 0, 0, 0, 1],
        };
        let hour = (rollup::floor(ts, HOUR_MS), family.clone(), dim.clone());
        add_to(hours.entry(hour).or_default(), values)?;
        add_to(
            days.entry((rollup::floor(ts, DAY_MS), family, dim))
                .or_default(),
            values,
        )?;
    }
    drop(rows);
    let hourly = read_spend(db, "spend_hourly")?;
    let daily = read_spend(db, "spend_daily")?;
    ensure!(hourly == hours, "spend_hourly differs from request_costs");
    ensure!(daily == days, "spend_daily differs from request_costs");
    for family in families.keys() {
        for (table, spend) in [
            ("request_hourly", "spend_hourly"),
            ("request_daily", "spend_daily"),
        ] {
            let wrong: i64 = db.query_row(
                &format!(
                    "SELECT COUNT(*) FROM {table} h LEFT JOIN {spend} s ON s.bucket_ms=h.bucket_ms
                       AND s.family=?1 AND s.dimension_key=h.dimension_key
                     WHERE h.endpoint IN ({}) AND COALESCE(s.priced_requests+s.estimated_requests+s.unpriced_requests,0)<>h.requests",
                    inference_list()
                ),
                [family],
                |r| r.get(0),
            )?;
            ensure!(
                wrong == 0,
                "{spend}: {wrong} {family} buckets do not classify every inference request"
            );
        }
    }
    Ok(Verified {
        raw_requests: requests.raw_requests,
        hourly_rows: requests.hourly_rows,
        daily_rows: requests.daily_rows,
        dimension_keys: requests.dimension_keys,
        input_tokens: requests.input_tokens,
        output_tokens: requests.output_tokens,
        input_known: requests.input_known,
        output_known: requests.output_known,
        spend_hourly_rows: hourly.len(),
        spend_daily_rows: daily.len(),
        families,
    })
}

#[derive(Debug, Serialize)]
pub struct Backfill {
    pub progress: Progress,
    pub elapsed_ms: u128,
    pub last_id: i64,
    pub tables: BTreeMap<String, i64>,
    pub comparison: Option<Verified>,
}

pub const TABLES: [&str; 9] = [
    "requests",
    "request_costs",
    "request_hourly",
    "request_daily",
    "request_latency_hourly",
    "request_latency_daily",
    "spend_hourly",
    "spend_daily",
    "rollup_state",
];

/// Offline backfill to completion (or until costs block it), then a repeat
/// comparison for the report. Each batch commits independently, so an
/// interrupted run resumes from the checkpoint.
pub fn backfill(db: &mut Connection) -> Result<Backfill> {
    let started = std::time::Instant::now();
    let mut total = Progress::default();
    loop {
        let progress = run(db, crate::now_ms(), BATCHES_PER_RUN)?;
        total.batches += progress.batches;
        total.rows += progress.rows;
        (total.caught_up, total.waiting_for_costs, total.verified) = (
            progress.caught_up,
            progress.waiting_for_costs,
            progress.verified,
        );
        if progress.caught_up || progress.waiting_for_costs {
            break;
        }
    }
    let last_id = rollup::state(db, JOB)?.map_or(0, |s| s.last_id);
    let tx = db.transaction()?;
    let comparison = total.verified.then(|| verify(&tx, last_id)).transpose()?;
    let tables = TABLES
        .iter()
        .map(|t| {
            Ok((
                (*t).to_owned(),
                tx.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))?,
            ))
        })
        .collect::<Result<_>>()?;
    drop(tx);
    Ok(Backfill {
        progress: total,
        elapsed_ms: started.elapsed().as_millis(),
        last_id,
        tables,
        comparison,
    })
}

/// Classifications that changed for requests already in the rollups: newly
/// inserted (a family added later) or unpriced -> estimated fill-ins. Applied
/// to hourly spend in the cost backfill transaction, then their days recomputed.
#[derive(Default)]
pub struct Rewrite {
    pub added: Vec<(i64, String)>,
    pub estimated: Vec<(i64, String)>,
    pub days: BTreeSet<i64>,
}

/// Existing statuses for (after, through], before new classifications are stored.
pub fn existing(
    db: &Connection,
    after: i64,
    through: i64,
) -> Result<BTreeMap<(i64, String), String>> {
    Ok(db
        .prepare_cached(
            "SELECT request_id,family,cost_status FROM request_costs WHERE request_id>?1 AND request_id<=?2",
        )?
        .query_map(params![after, through], |r| {
            Ok(((r.get(0)?, r.get(1)?), r.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?)
}

impl Rewrite {
    /// `ts_ms` maps each stored request ID to its timestamp.
    pub fn new(
        stored: &[costs::Cost],
        before: &BTreeMap<(i64, String), String>,
        rolled_through: i64,
        ts_ms: &BTreeMap<i64, i64>,
    ) -> Self {
        let mut rewrite = Self::default();
        for c in stored.iter().filter(|c| c.request_id <= rolled_through) {
            let key = (c.request_id, c.family.clone());
            let changed = match before.get(&key).map(String::as_str) {
                None => {
                    rewrite.added.push(key);
                    true
                }
                Some("unpriced") if c.status == costs::Status::Estimated => {
                    rewrite.estimated.push(key);
                    true
                }
                _ => false,
            };
            if changed && let Some(ts) = ts_ms.get(&c.request_id) {
                rewrite.days.insert(rollup::floor(*ts, DAY_MS));
            }
        }
        rewrite
    }

    /// At most three statements for a ≤500-row page: added-family upsert,
    /// fill-in update and the affected days' recompute.
    pub fn apply(&self, db: &Connection) -> Result<()> {
        if self.added.is_empty() && self.estimated.is_empty() {
            return Ok(());
        }
        for (keys, added) in [(&self.added, true), (&self.estimated, false)] {
            for chunk in keys.chunks(10_000) {
                let values = vec!["(?,?)"; chunk.len()].join(",");
                let parameters: Vec<rusqlite::types::Value> = chunk
                    .iter()
                    .flat_map(|(id, family)| [(*id).into(), family.clone().into()])
                    .collect();
                let select = format!(
                    "SELECT r.ts_ms-r.ts_ms%{HOUR_MS} AS bucket,c.family AS family,
                       json_array(r.endpoint,r.model,r.user_key,r.actor_kind) AS dim,
                       r.endpoint,r.model,r.user_key,r.actor_kind,
                       COALESCE(SUM(CASE WHEN c.cost_status='priced' THEN c.cost_nano_usd END),0),
                       COALESCE(SUM(CASE WHEN c.cost_status='estimated' THEN c.cost_nano_usd END),0) AS estimated,
                       SUM(c.cost_status='priced'),SUM(c.cost_status='estimated') AS n,SUM(c.cost_status='unpriced')
                     FROM requests r JOIN request_costs c ON c.request_id=r.id
                     WHERE (c.request_id,c.family) IN (VALUES {values}) GROUP BY 1,2,3"
                );
                if added {
                    db.execute(
                        &format!(
                            "INSERT INTO spend_hourly(bucket_ms,family,dimension_key,endpoint,model,user_key,actor_kind,{c})
                             {select} ON CONFLICT(bucket_ms,family,dimension_key) DO UPDATE SET {u}",
                            c = SPEND.join(","),
                            u = SPEND.map(|c| format!("{c}={c}+excluded.{c}")).join(",")
                        ),
                        params_from_iter(parameters.iter()),
                    )?;
                } else {
                    let changed = db.execute(
                        &format!(
                            "UPDATE spend_hourly SET unpriced_requests=unpriced_requests-v.n,
                               estimated_requests=estimated_requests+v.n,
                               estimated_nano_usd=estimated_nano_usd+v.estimated
                             FROM ({select}) v
                             WHERE spend_hourly.bucket_ms=v.bucket AND spend_hourly.family=v.family
                               AND spend_hourly.dimension_key=v.dim"
                        ),
                        params_from_iter(parameters.iter()),
                    )?;
                    ensure!(changed > 0, "estimate fill-in found no spend rollup rows");
                }
            }
        }
        recompute_spend_days(db, &self.days)
    }
}
