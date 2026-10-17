//! Request rollups shared by meter and factory-api (docs/data-model.md, MET-205).
//!
//! Both owners define identical `request_hourly`, `request_daily`,
//! `request_latency_hourly`, `request_latency_daily` and `rollup_state` tables in
//! their own migrations; only the aggregation and read rules live here. A batch
//! takes ascending `requests.id > last_id`, adds its contributions to hourly rows,
//! recomputes every affected UTC day from hourly rows and advances the checkpoint,
//! all in the caller's transaction. Reads combine daily interior, hourly remainder
//! and a raw edge that is disjoint from the aggregates by both time and ID.
use anyhow::{Context, Result, anyhow, ensure};
use rusqlite::{Connection, Row, params, params_from_iter, types::Value};
use std::collections::{BTreeMap, BTreeSet};

pub const HOUR_MS: i64 = 3_600_000;
pub const DAY_MS: i64 = 86_400_000;
/// Input rows per rollup transaction.
pub const BATCH: usize = 5_000;
/// Bound parameters per statement (SQLite's default SQLITE_MAX_VARIABLE_NUMBER).
const VARIABLES: usize = 32_766;

pub fn floor(ts_ms: i64, width: i64) -> i64 {
    ts_ms - ts_ms.rem_euclid(width)
}

pub fn ceil(ts_ms: i64, width: i64) -> i64 {
    let floor = floor(ts_ms, width);
    if floor == ts_ms { floor } else { floor + width }
}

/// Request latency used by every percentile: Ollama total duration, else wall time.
pub fn latency_ms(total_duration_ns: Option<i64>, latency_ms: f64) -> f64 {
    total_duration_ns.map_or(latency_ms, |ns| ns as f64 / 1_000_000.0)
}

/// Nearest-rank percentile of sorted values, as the raw endpoints always computed it.
pub fn nearest_rank(sorted: &[f64], p: f64) -> Option<f64> {
    let rank = (sorted.len() as f64 * p).ceil() as usize;
    sorted.get(rank.checked_sub(1)?).copied()
}

/// Fixed, versioned latency histogram. Scheme 1: exact microsecond bins below
/// 8 µs, then eight log-linear bins per power of two (at most 12.5% wide).
/// Changing bins requires a new scheme number; stored scheme-1 rows never change.
pub mod latency {
    use std::collections::BTreeMap;

    pub const SCHEME: i64 = 1;
    pub const MAX_BIN: i64 = 495;

    pub fn bin(ms: f64) -> i64 {
        // Saturating float-to-int conversion; NaN cannot be stored (CHECK >= 0).
        let us = (ms * 1000.0) as u64;
        if us < 8 {
            return us as i64;
        }
        let exponent = 63 - i64::from(us.leading_zeros());
        let mantissa = ((us >> (exponent - 3)) & 7) as i64;
        8 * (exponent - 2) + mantissa
    }

    /// Half-open [lower, upper) bounds in microseconds.
    pub fn bounds_us(bin: i64) -> (f64, f64) {
        if bin < 8 {
            return (bin as f64, bin as f64 + 1.0);
        }
        let (exponent, mantissa) = (bin / 8 + 2, bin % 8);
        let scale = 2f64.powi((exponent - 3) as i32);
        ((8 + mantissa) as f64 * scale, (9 + mantissa) as f64 * scale)
    }

    /// Bin midpoint in milliseconds: the approximate value of every member.
    pub fn representative_ms(bin: i64) -> f64 {
        let (lower, upper) = bounds_us(bin);
        (lower + upper) / 2000.0
    }

    /// Nearest-rank percentile over merged bins, reported as the bin midpoint.
    pub fn percentile(bins: &BTreeMap<i64, u64>, p: f64) -> Option<f64> {
        let total: u64 = bins.values().sum();
        let rank = ((total as f64 * p).ceil() as u64).max(1);
        if total == 0 {
            return None;
        }
        let mut seen = 0;
        for (bin, count) in bins {
            seen += count;
            if seen >= rank {
                return Some(representative_ms(*bin));
            }
        }
        None
    }
}

/// Per-request throughput ratio. Each owner keeps the formula its raw endpoint
/// used, so averages remain the mean of the same per-request ratios.
#[derive(Clone, Copy, Debug)]
pub enum Tps {
    /// Meter `/meter/stats`: tokens * 1e9 / ns.
    Meter,
    /// API usage: tokens / (ns / 1e9).
    Api,
}

impl Tps {
    pub fn rate(self, tokens: Option<i64>, ns: Option<i64>) -> Option<f64> {
        match (tokens, ns) {
            (Some(t), Some(d)) if d > 0 => Some(match self {
                Self::Meter => t as f64 * 1e9 / d as f64,
                Self::Api => t as f64 / (d as f64 / 1e9),
            }),
            _ => None,
        }
    }
}

/// Rollup dimensions. The stored key is SQLite `json_array(...)` of these,
/// always computed by SQLite so Rust never re-implements its JSON escaping.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Dim {
    pub endpoint: String,
    pub model: Option<String>,
    pub user_key: Option<String>,
    pub actor_kind: String,
}

/// The aggregated columns of one raw request row.
#[derive(Clone, Debug)]
pub struct Raw {
    pub id: i64,
    pub ts_ms: i64,
    pub dim: Dim,
    pub prompt_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub load_ns: Option<i64>,
    pub prompt_ns: Option<i64>,
    pub eval_ns: Option<i64>,
    pub total_ns: Option<i64>,
    pub latency_ms: f64,
}

/// Raw columns read by `raw`, optionally qualified by a table alias.
pub fn raw_columns(alias: &str) -> String {
    let prefix = if alias.is_empty() {
        String::new()
    } else {
        format!("{alias}.")
    };
    [
        "id",
        "ts_ms",
        "endpoint",
        "model",
        "user_key",
        "actor_kind",
        "prompt_eval_count",
        "eval_count",
        "load_duration_ns",
        "prompt_eval_duration_ns",
        "eval_duration_ns",
        "total_duration_ns",
        "latency_ms",
    ]
    .map(|c| format!("{prefix}{c}"))
    .join(",")
}
pub const RAW_WIDTH: usize = 13;

pub fn raw(row: &Row<'_>) -> rusqlite::Result<Raw> {
    Ok(Raw {
        id: row.get(0)?,
        ts_ms: row.get(1)?,
        dim: Dim {
            endpoint: row.get(2)?,
            model: row.get(3)?,
            user_key: row.get(4)?,
            actor_kind: row.get(5)?,
        },
        prompt_tokens: row.get(6)?,
        output_tokens: row.get(7)?,
        load_ns: row.get(8)?,
        prompt_ns: row.get(9)?,
        eval_ns: row.get(10)?,
        total_ns: row.get(11)?,
        latency_ms: row.get(12)?,
    })
}

impl Raw {
    pub fn latency(&self) -> f64 {
        latency_ms(self.total_ns, self.latency_ms)
    }
}

/// Mergeable per-bucket sums. Averages are sum/count, never averaged averages;
/// unknown tokens and loads are counted separately from known zeroes.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Agg {
    pub requests: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub input_known: i64,
    pub output_known: i64,
    pub prompt_tps_sum: f64,
    pub prompt_tps_count: i64,
    pub generation_tps_sum: f64,
    pub generation_tps_count: i64,
    pub load_ns: i64,
    pub load_known: i64,
}

pub const AGG_COLUMNS: &str = "requests,input_tokens,output_tokens,input_known_count,output_known_count,prompt_tps_sum,prompt_tps_count,generation_tps_sum,generation_tps_count,total_load_ns,load_known_count";
const AGG_NAMES: [&str; 11] = [
    "requests",
    "input_tokens",
    "output_tokens",
    "input_known_count",
    "output_known_count",
    "prompt_tps_sum",
    "prompt_tps_count",
    "generation_tps_sum",
    "generation_tps_count",
    "total_load_ns",
    "load_known_count",
];

fn add(a: i64, b: i64) -> Result<i64> {
    a.checked_add(b)
        .ok_or_else(|| anyhow!("rollup sum overflow"))
}

impl Agg {
    pub fn add(&mut self, r: &Raw, tps: Tps) -> Result<()> {
        self.requests = add(self.requests, 1)?;
        if let Some(t) = r.prompt_tokens {
            self.input_tokens = add(self.input_tokens, t)?;
            self.input_known = add(self.input_known, 1)?;
        }
        if let Some(t) = r.output_tokens {
            self.output_tokens = add(self.output_tokens, t)?;
            self.output_known = add(self.output_known, 1)?;
        }
        if let Some(rate) = tps.rate(r.prompt_tokens, r.prompt_ns) {
            self.prompt_tps_sum += rate;
            self.prompt_tps_count = add(self.prompt_tps_count, 1)?;
        }
        if let Some(rate) = tps.rate(r.output_tokens, r.eval_ns) {
            self.generation_tps_sum += rate;
            self.generation_tps_count = add(self.generation_tps_count, 1)?;
        }
        if let Some(ns) = r.load_ns {
            self.load_ns = add(self.load_ns, ns)?;
            self.load_known = add(self.load_known, 1)?;
        }
        Ok(())
    }

    pub fn merge(&mut self, o: &Agg) -> Result<()> {
        self.requests = add(self.requests, o.requests)?;
        self.input_tokens = add(self.input_tokens, o.input_tokens)?;
        self.output_tokens = add(self.output_tokens, o.output_tokens)?;
        self.input_known = add(self.input_known, o.input_known)?;
        self.output_known = add(self.output_known, o.output_known)?;
        self.prompt_tps_sum += o.prompt_tps_sum;
        self.prompt_tps_count = add(self.prompt_tps_count, o.prompt_tps_count)?;
        self.generation_tps_sum += o.generation_tps_sum;
        self.generation_tps_count = add(self.generation_tps_count, o.generation_tps_count)?;
        self.load_ns = add(self.load_ns, o.load_ns)?;
        self.load_known = add(self.load_known, o.load_known)?;
        Ok(())
    }

    pub fn avg_prompt_tps(&self) -> Option<f64> {
        (self.prompt_tps_count > 0).then(|| self.prompt_tps_sum / self.prompt_tps_count as f64)
    }

    pub fn avg_generation_tps(&self) -> Option<f64> {
        (self.generation_tps_count > 0)
            .then(|| self.generation_tps_sum / self.generation_tps_count as f64)
    }

    fn values(&self) -> [Value; 11] {
        [
            self.requests.into(),
            self.input_tokens.into(),
            self.output_tokens.into(),
            self.input_known.into(),
            self.output_known.into(),
            self.prompt_tps_sum.into(),
            self.prompt_tps_count.into(),
            self.generation_tps_sum.into(),
            self.generation_tps_count.into(),
            self.load_ns.into(),
            self.load_known.into(),
        ]
    }

    /// Integer columns must match exactly; REAL ratio sums within 1e-9 relative.
    fn matches(&self, o: &Agg) -> bool {
        let close = |a: f64, b: f64| (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1.0);
        Agg {
            prompt_tps_sum: 0.0,
            generation_tps_sum: 0.0,
            ..self.clone()
        } == Agg {
            prompt_tps_sum: 0.0,
            generation_tps_sum: 0.0,
            ..o.clone()
        } && close(self.prompt_tps_sum, o.prompt_tps_sum)
            && close(self.generation_tps_sum, o.generation_tps_sum)
    }
}

/// Read `AGG_COLUMNS` starting at `offset`.
pub fn agg(row: &Row<'_>, offset: usize) -> rusqlite::Result<Agg> {
    Ok(Agg {
        requests: row.get(offset)?,
        input_tokens: row.get(offset + 1)?,
        output_tokens: row.get(offset + 2)?,
        input_known: row.get(offset + 3)?,
        output_known: row.get(offset + 4)?,
        prompt_tps_sum: row.get(offset + 5)?,
        prompt_tps_count: row.get(offset + 6)?,
        generation_tps_sum: row.get(offset + 7)?,
        generation_tps_count: row.get(offset + 8)?,
        load_ns: row.get(offset + 9)?,
        load_known: row.get(offset + 10)?,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    pub last_id: i64,
    pub updated_at_ms: i64,
    pub verified_at_ms: Option<i64>,
}

pub fn state(db: &Connection, job: &str) -> Result<Option<State>> {
    use rusqlite::OptionalExtension;
    Ok(db
        .query_row(
            "SELECT last_id,updated_at_ms,verified_at_ms FROM rollup_state WHERE job=?1",
            [job],
            |r| {
                Ok(State {
                    last_id: r.get(0)?,
                    updated_at_ms: r.get(1)?,
                    verified_at_ms: r.get(2)?,
                })
            },
        )
        .optional()?)
}

/// Record the checkpoint in the batch's transaction. The row first appears with
/// the first committed aggregates; the checkpoint never moves backwards.
pub fn advance(db: &Connection, job: &str, last_id: i64, now_ms: i64) -> Result<()> {
    let changed = db.execute(
        "INSERT INTO rollup_state(job,last_id,updated_at_ms) VALUES (?1,?2,?3)
         ON CONFLICT(job) DO UPDATE SET last_id=excluded.last_id,updated_at_ms=excluded.updated_at_ms
         WHERE excluded.last_id>=rollup_state.last_id",
        params![job, last_id, now_ms],
    )?;
    ensure!(changed == 1, "{job} rollup checkpoint would move backwards");
    Ok(())
}

pub fn mark_verified(db: &Connection, job: &str, now_ms: i64) -> Result<()> {
    let changed = db.execute(
        "UPDATE rollup_state SET verified_at_ms=?2,updated_at_ms=?2 WHERE job=?1",
        params![job, now_ms],
    )?;
    ensure!(changed == 1, "{job} rollup state missing");
    Ok(())
}

/// The next ascending batch after the checkpoint, never past `through`.
pub fn batch(db: &Connection, after_id: i64, through_id: i64) -> Result<Vec<Raw>> {
    Ok(db
        .prepare_cached(&format!(
            "SELECT {} FROM requests WHERE id>?1 AND id<=?2 ORDER BY id LIMIT ?3",
            raw_columns("")
        ))?
        .query_map(params![after_id, through_id, BATCH as i64], raw)?
        .collect::<rusqlite::Result<_>>()?)
}

fn chunks<T>(items: &[T], width: usize) -> std::slice::Chunks<'_, T> {
    items.chunks((VARIABLES / width).max(1))
}

fn tuples(count: usize, width: usize) -> String {
    let tuple = format!("({})", vec!["?"; width].join(","));
    vec![tuple.as_str(); count].join(",")
}

fn dim_values(dim: &Dim) -> [Value; 4] {
    [
        dim.endpoint.clone().into(),
        dim.model.clone().into(),
        dim.user_key.clone().into(),
        dim.actor_kind.clone().into(),
    ]
}

/// Add one batch of raw requests to hourly rows and histograms, then recompute
/// every affected day from hourly rows. Returns the affected UTC days.
pub fn apply(db: &Connection, rows: &[Raw], tps: Tps) -> Result<BTreeSet<i64>> {
    let mut hourly = BTreeMap::<(i64, &Dim), Agg>::new();
    let mut bins = BTreeMap::<(i64, &Dim, i64), i64>::new();
    for r in rows {
        let bucket = floor(r.ts_ms, HOUR_MS);
        hourly
            .entry((bucket, &r.dim))
            .or_default()
            .add(r, tps)
            .with_context(|| format!("request {}", r.id))?;
        let count = bins
            .entry((bucket, &r.dim, latency::bin(r.latency())))
            .or_default();
        *count = add(*count, 1)?;
    }
    let hourly: Vec<_> = hourly.into_iter().collect();
    let updates = AGG_NAMES.map(|c| format!("{c}={c}+excluded.{c}")).join(",");
    let selected = (6..=16).map(|i| format!("column{i}")).collect::<Vec<_>>();
    for chunk in chunks(&hourly, 16) {
        let mut values = Vec::with_capacity(chunk.len() * 16);
        for ((bucket, dim), agg) in chunk {
            values.push((*bucket).into());
            values.extend(dim_values(dim));
            values.extend(agg.values());
        }
        db.prepare_cached(&format!(
            "INSERT INTO request_hourly(bucket_ms,dimension_key,endpoint,model,user_key,actor_kind,{AGG_COLUMNS})
             SELECT column1,json_array(column2,column3,column4,column5),column2,column3,column4,column5,{}
             FROM (VALUES {}) WHERE true
             ON CONFLICT(bucket_ms,dimension_key) DO UPDATE SET {updates}",
            selected.join(","),
            tuples(chunk.len(), 16)
        ))?
        .execute(params_from_iter(values))?;
    }
    let bins: Vec<_> = bins.into_iter().collect();
    for chunk in chunks(&bins, 7) {
        let mut values = Vec::with_capacity(chunk.len() * 7);
        for ((bucket, dim, bin), count) in chunk {
            values.push((*bucket).into());
            values.extend(dim_values(dim));
            values.push((*bin).into());
            values.push((*count).into());
        }
        db.prepare_cached(&format!(
            "INSERT INTO request_latency_hourly(bucket_ms,dimension_key,scheme,bin,requests)
             SELECT column1,json_array(column2,column3,column4,column5),{},column6,column7
             FROM (VALUES {}) WHERE true
             ON CONFLICT(bucket_ms,dimension_key,scheme,bin) DO UPDATE SET requests=requests+excluded.requests",
            latency::SCHEME,
            tuples(chunk.len(), 7)
        ))?
        .execute(params_from_iter(values))?;
    }
    let days: BTreeSet<i64> = rows.iter().map(|r| floor(r.ts_ms, DAY_MS)).collect();
    recompute_days(db, &days)?;
    Ok(days)
}

/// `WITH d(day) AS (VALUES ...)` for a chunk of days, plus its parameters.
pub fn days_cte(days: &[i64]) -> (String, Vec<Value>) {
    (
        format!("WITH d(day) AS (VALUES {})", tuples(days.len(), 1)),
        days.iter().map(|d| (*d).into()).collect(),
    )
}

/// Replace each listed day's daily rows and histograms with sums of its hours.
pub fn recompute_days(db: &Connection, days: &BTreeSet<i64>) -> Result<()> {
    let days: Vec<i64> = days.iter().copied().collect();
    let sums = AGG_NAMES.map(|c| format!("SUM(h.{c})")).join(",");
    let replace = AGG_NAMES.map(|c| format!("{c}=excluded.{c}")).join(",");
    for chunk in chunks(&days, 1) {
        let (cte, values) = days_cte(chunk);
        db.prepare_cached(&format!(
            "{cte} INSERT INTO request_daily(bucket_ms,dimension_key,endpoint,model,user_key,actor_kind,{AGG_COLUMNS})
             SELECT d.day,h.dimension_key,h.endpoint,h.model,h.user_key,h.actor_kind,{sums}
             FROM d JOIN request_hourly h ON h.bucket_ms>=d.day AND h.bucket_ms<d.day+{DAY_MS}
             WHERE true GROUP BY d.day,h.dimension_key
             ON CONFLICT(bucket_ms,dimension_key) DO UPDATE SET {replace}"
        ))?
        .execute(params_from_iter(values.iter()))?;
        db.prepare_cached(&format!(
            "{cte} INSERT INTO request_latency_daily(bucket_ms,dimension_key,scheme,bin,requests)
             SELECT d.day,h.dimension_key,h.scheme,h.bin,SUM(h.requests)
             FROM d JOIN request_latency_hourly h ON h.bucket_ms>=d.day AND h.bucket_ms<d.day+{DAY_MS}
             WHERE true GROUP BY d.day,h.dimension_key,h.scheme,h.bin
             ON CONFLICT(bucket_ms,dimension_key,scheme,bin) DO UPDATE SET requests=excluded.requests"
        ))?
        .execute(params_from_iter(values))?;
    }
    Ok(())
}

/// Aggregate-versus-raw comparison over every ID at or below the checkpoint.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Verified {
    pub raw_requests: i64,
    pub hourly_rows: usize,
    pub daily_rows: usize,
    pub dimension_keys: usize,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub input_known: i64,
    pub output_known: i64,
}

type Keyed = BTreeMap<(i64, Dim), Agg>;

fn read_table(db: &Connection, table: &str) -> Result<Keyed> {
    let mut result = Keyed::new();
    let mut statement = db.prepare(&format!(
        "SELECT bucket_ms,endpoint,model,user_key,actor_kind,{AGG_COLUMNS},dimension_key=json_array(endpoint,model,user_key,actor_kind) FROM {table}"
    ))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        ensure!(row.get::<_, bool>(16)?, "{table}: dimension key mismatch");
        let dim = Dim {
            endpoint: row.get(1)?,
            model: row.get(2)?,
            user_key: row.get(3)?,
            actor_kind: row.get(4)?,
        };
        result.insert((row.get(0)?, dim), agg(row, 5)?);
    }
    Ok(result)
}

fn read_bins(db: &Connection, table: &str) -> Result<BTreeMap<(i64, String, i64, i64), i64>> {
    let mut statement = db.prepare(&format!(
        "SELECT bucket_ms,dimension_key,scheme,bin,requests FROM {table}"
    ))?;
    let rows = statement.query_map([], |r| {
        Ok(((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?), r.get(4)?))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// One-time full comparison before publishing the rollup-complete state. It is
/// the reviewed migration-scan exception: one raw walk plus whole rollup reads.
/// Hourly and daily rows must equal raw sums per (bucket, dimension) exactly for
/// counts, token sums and NULL-aware known counts; histograms per bin.
pub fn verify(db: &Connection, last_id: i64, tps: Tps) -> Result<Verified> {
    let mut hours = Keyed::new();
    let mut days = Keyed::new();
    let mut day_bins = BTreeMap::<(i64, String, i64, i64), i64>::new();
    let mut keys = BTreeMap::<Dim, String>::new();
    let mut statement = db.prepare(&format!(
        "SELECT {},json_array(endpoint,model,user_key,actor_kind) FROM requests WHERE id<=?1",
        raw_columns("")
    ))?;
    let mut rows = statement.query([last_id])?;
    while let Some(row) = rows.next()? {
        let r = raw(row)?;
        if !keys.contains_key(&r.dim) {
            keys.insert(r.dim.clone(), row.get(RAW_WIDTH)?);
        }
        let day = floor(r.ts_ms, DAY_MS);
        hours
            .entry((floor(r.ts_ms, HOUR_MS), r.dim.clone()))
            .or_default()
            .add(&r, tps)?;
        let bin = (
            day,
            keys[&r.dim].clone(),
            latency::SCHEME,
            latency::bin(r.latency()),
        );
        *day_bins.entry(bin).or_default() += 1;
        days.entry((day, r.dim)).or_default().add(&raw(row)?, tps)?;
    }
    drop(rows);
    let compare = |name: &str, expected: &Keyed, actual: &Keyed| -> Result<()> {
        ensure!(
            expected.len() == actual.len(),
            "{name}: {} raw buckets, {} rollup rows",
            expected.len(),
            actual.len()
        );
        for (key, sum) in expected {
            let row = actual
                .get(key)
                .with_context(|| format!("{name}: missing bucket {key:?}"))?;
            ensure!(
                row.matches(sum),
                "{name}: {key:?} rollup {row:?} != raw {sum:?}"
            );
        }
        Ok(())
    };
    let hourly = read_table(db, "request_hourly")?;
    let daily = read_table(db, "request_daily")?;
    compare("request_hourly", &hours, &hourly)?;
    compare("request_daily", &days, &daily)?;
    ensure!(
        read_bins(db, "request_latency_daily")? == day_bins,
        "request_latency_daily differs from raw latency bins"
    );
    let mut hour_bins = BTreeMap::<(i64, String), i64>::new();
    for ((bucket, key, _, _), count) in read_bins(db, "request_latency_hourly")? {
        *hour_bins.entry((bucket, key)).or_default() += count;
    }
    let expected: BTreeMap<(i64, String), i64> = hours
        .iter()
        .map(|((bucket, dim), agg)| ((*bucket, keys[dim].clone()), agg.requests))
        .collect();
    ensure!(
        hour_bins == expected,
        "request_latency_hourly totals differ from request counts"
    );
    let mut total = Agg::default();
    for agg in hours.values() {
        total.merge(agg)?;
    }
    Ok(Verified {
        raw_requests: total.requests,
        hourly_rows: hourly.len(),
        daily_rows: daily.len(),
        dimension_keys: keys.len(),
        input_tokens: total.input_tokens,
        output_tokens: total.output_tokens,
        input_known: total.input_known,
        output_known: total.output_known,
    })
}

/// Half-open read partition for a range starting at `since` with no upper bound:
/// raw rows in [since, hour), hourly rollups in [hour, day), daily from `day`.
/// Rows above the checkpoint are read raw whatever their timestamp.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Window {
    pub since: i64,
    pub hour: i64,
    pub day: i64,
}

impl Window {
    pub fn new(since: i64) -> Self {
        Self {
            since,
            hour: ceil(since, HOUR_MS),
            day: ceil(since, DAY_MS),
        }
    }
}

/// The verified checkpoint, or 0 (read everything raw) before publication.
pub fn verified_last(job: &str) -> String {
    format!(
        "COALESCE((SELECT last_id FROM rollup_state WHERE job='{job}' AND verified_at_ms IS NOT NULL),0)"
    )
}

fn verified(job: &str) -> String {
    format!("EXISTS(SELECT 1 FROM rollup_state WHERE job='{job}' AND verified_at_ms IS NOT NULL)")
}

/// Rollup rows for a window: `endpoint, model, AGG_COLUMNS`. Parameters
/// ?1 = window.hour, ?2 = window.day; `filter` may bind ?3.
pub fn rollup_sql(filter: &str) -> String {
    let verified = verified("requests");
    format!(
        "SELECT endpoint,model,{AGG_COLUMNS} FROM request_hourly WHERE bucket_ms>=?1 AND bucket_ms<?2 AND {verified}{filter}
         UNION ALL SELECT endpoint,model,{AGG_COLUMNS} FROM request_daily WHERE bucket_ms>=?2 AND {verified}{filter}"
    )
}

/// Histogram rows for a window: `endpoint, model, bin, requests`. Same parameters.
pub fn histogram_sql(filter: &str) -> String {
    let verified = verified("requests");
    let select = "SELECT dimension_key->>0,dimension_key->>1,bin,requests";
    format!(
        "{select} FROM request_latency_hourly WHERE bucket_ms>=?1 AND bucket_ms<?2 AND scheme={s} AND {verified}{filter}
         UNION ALL {select} FROM request_latency_daily WHERE bucket_ms>=?2 AND scheme={s} AND {verified}{filter}",
        s = latency::SCHEME
    )
}

/// Raw edge for a window: [since, hour) by time, plus every row above the
/// verified checkpoint from `hour` on. Parameters ?1 = since, ?2 = hour.
/// `select` is the column list (with `r.` alias), `join` an optional join.
pub fn edge_sql(select: &str, join: &str, filter: &str) -> String {
    let last = verified_last("requests");
    format!(
        "SELECT {select} FROM requests r {join} WHERE r.ts_ms>=?1 AND r.ts_ms<?2{filter}
         UNION ALL SELECT {select} FROM requests r {join} WHERE r.id>{last} AND r.ts_ms>=?2{filter}"
    )
}

/// One model's combined usage: rollups plus raw edge, and its percentiles.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Summary {
    pub agg: Agg,
    pub p50_ms: Option<f64>,
    pub p95_ms: Option<f64>,
}

/// Percentile inputs: exact raw latencies, or merged histogram bins.
pub enum Latencies {
    Exact(Vec<(Option<String>, f64)>),
    Approximate(Vec<(Option<String>, i64, u64)>),
}

/// Combine disjoint rollup rows and raw edge rows by model. `latencies` already
/// covers the whole range for exact percentiles; approximate bins exclude the
/// edge, which is binned here.
pub fn summarize(
    rollups: Vec<(Option<String>, Agg)>,
    edge: &[Raw],
    latencies: Latencies,
    tps: Tps,
) -> Result<BTreeMap<Option<String>, Summary>> {
    let mut models = BTreeMap::<Option<String>, Summary>::new();
    for (model, agg) in rollups {
        models.entry(model).or_default().agg.merge(&agg)?;
    }
    for r in edge {
        models
            .entry(r.dim.model.clone())
            .or_default()
            .agg
            .add(r, tps)?;
    }
    match latencies {
        Latencies::Exact(values) => {
            let mut grouped = BTreeMap::<Option<String>, Vec<f64>>::new();
            for (model, ms) in values {
                grouped.entry(model).or_default().push(ms);
            }
            for (model, mut values) in grouped {
                values.sort_by(f64::total_cmp);
                let summary = models.entry(model).or_default();
                summary.p50_ms = nearest_rank(&values, 0.5);
                summary.p95_ms = nearest_rank(&values, 0.95);
            }
        }
        Latencies::Approximate(bins) => {
            let mut grouped = BTreeMap::<Option<String>, BTreeMap<i64, u64>>::new();
            for (model, bin, count) in bins {
                *grouped.entry(model).or_default().entry(bin).or_default() += count;
            }
            for r in edge {
                *grouped
                    .entry(r.dim.model.clone())
                    .or_default()
                    .entry(latency::bin(r.latency()))
                    .or_default() += 1;
            }
            for (model, bins) in grouped {
                let summary = models.entry(model).or_default();
                summary.p50_ms = latency::percentile(&bins, 0.5);
                summary.p95_ms = latency::percentile(&bins, 0.95);
            }
        }
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_buckets_and_window_edges() {
        assert_eq!(floor(7_199_999, HOUR_MS), 3_600_000);
        assert_eq!(ceil(3_600_000, HOUR_MS), 3_600_000);
        assert_eq!(ceil(3_600_001, HOUR_MS), 7_200_000);
        let w = Window::new(DAY_MS + HOUR_MS + 1);
        assert_eq!((w.hour, w.day), (DAY_MS + 2 * HOUR_MS, 2 * DAY_MS));
        let aligned = Window::new(2 * DAY_MS);
        assert_eq!((aligned.hour, aligned.day), (2 * DAY_MS, 2 * DAY_MS));
    }

    #[test]
    fn latency_bins_are_monotone_bounded_and_contain_their_values() {
        let mut previous = 0;
        for us in (0..200_000u64).chain([1 << 50, (1 << 50) + 12_345]) {
            let ms = us as f64 / 1000.0;
            let bin = latency::bin(ms);
            assert!(bin >= previous || us > 200_000, "{us}");
            assert!((0..=latency::MAX_BIN).contains(&bin));
            let (lower, upper) = latency::bounds_us(bin);
            let exact = (ms * 1000.0) as u64 as f64;
            assert!(lower <= exact && exact < upper, "{us}: {lower}..{upper}");
            assert!(bin < 8 || (upper - lower) / lower <= 0.125);
            previous = bin;
        }
        assert_eq!(latency::bin(f64::INFINITY), latency::MAX_BIN);
        // Bin 8 starts the log-linear range at 8 µs; widths double per octave.
        assert_eq!(latency::bounds_us(8), (8.0, 9.0));
        assert_eq!(latency::bounds_us(16), (16.0, 18.0));
    }

    #[test]
    fn merged_histograms_equal_one_histogram_and_track_exact_ranks() {
        let values: Vec<f64> = (1..=997).map(|i| (i * i % 7919) as f64 / 3.0).collect();
        let mut one = BTreeMap::<i64, u64>::new();
        let (mut a, mut b) = (BTreeMap::<i64, u64>::new(), BTreeMap::<i64, u64>::new());
        for (i, v) in values.iter().enumerate() {
            *one.entry(latency::bin(*v)).or_default() += 1;
            *if i % 3 == 0 { &mut a } else { &mut b }
                .entry(latency::bin(*v))
                .or_default() += 1;
        }
        for (bin, count) in a {
            *b.entry(bin).or_default() += count;
        }
        assert_eq!(one, b);
        let mut sorted = values.clone();
        sorted.sort_by(f64::total_cmp);
        for p in [0.5, 0.95] {
            let exact = nearest_rank(&sorted, p).unwrap();
            let approximate = latency::percentile(&one, p).unwrap();
            // The approximate value is the midpoint of the exact value's bin.
            assert_eq!(approximate, latency::representative_ms(latency::bin(exact)));
            assert!((approximate - exact).abs() <= exact * 0.0625 + 0.001);
        }
        assert_eq!(latency::percentile(&BTreeMap::new(), 0.5), None);
    }

    #[test]
    fn null_tokens_are_unknown_and_zero_tokens_are_known() {
        let raw = |prompt, ns| Raw {
            id: 1,
            ts_ms: 0,
            dim: Dim {
                endpoint: "/api/chat".into(),
                model: None,
                user_key: None,
                actor_kind: "unattributed".into(),
            },
            prompt_tokens: prompt,
            output_tokens: None,
            load_ns: Some(0),
            prompt_ns: ns,
            eval_ns: None,
            total_ns: None,
            latency_ms: 1.0,
        };
        let mut agg = Agg::default();
        agg.add(&raw(None, Some(1)), Tps::Api).unwrap();
        agg.add(&raw(Some(0), Some(1_000_000_000)), Tps::Api)
            .unwrap();
        agg.add(&raw(Some(30), Some(0)), Tps::Api).unwrap();
        assert_eq!(
            (
                agg.requests,
                agg.input_tokens,
                agg.input_known,
                agg.output_known
            ),
            (3, 30, 2, 0)
        );
        // Mean of per-request ratios with positive durations only.
        assert_eq!((agg.prompt_tps_count, agg.avg_prompt_tps()), (1, Some(0.0)));
        assert_eq!((agg.load_ns, agg.load_known), (0, 3));
        let mut overflow = Agg {
            input_tokens: i64::MAX,
            ..Agg::default()
        };
        assert!(overflow.add(&raw(Some(1), None), Tps::Api).is_err());
    }
}
