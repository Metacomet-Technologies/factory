//! Meter rollup jobs (MET-205): request hourly/daily rollups for all endpoints
//! and per-GPU hourly summaries. Each batch reads at most 5,000 ascending IDs
//! above its checkpoint and commits aggregates and checkpoint together.
use crate::storage;
use anyhow::{Context, Result, ensure};
use factory_db::rollup::{self, HOUR_MS, Tps};
use rusqlite::{Connection, TransactionBehavior, params, params_from_iter, types::Value};
use shared::GpuSample;
use std::collections::BTreeMap;

/// Batches per job and run; the next five-minute run resumes from the checkpoint.
pub const BATCHES_PER_RUN: usize = 20;
pub const TPS: Tps = Tps::Meter;

#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Progress {
    pub batches: usize,
    pub rows: usize,
    pub caught_up: bool,
    pub verified: bool,
}

/// One request batch, or the one-time verification once caught up.
/// Returns the number of rows aggregated (0 when caught up).
pub fn request_batch(db: &mut Connection, now_ms: i64) -> Result<usize> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let state = rollup::state(&tx, "requests")?;
    let last = state.as_ref().map_or(0, |s| s.last_id);
    let rows = rollup::batch(&tx, last, i64::MAX)?;
    if rows.is_empty() {
        if state.as_ref().is_none_or(|s| s.verified_at_ms.is_none()) {
            rollup::advance(&tx, "requests", last, now_ms)?;
            rollup::verify(&tx, last, TPS).context("request rollup verification")?;
            rollup::mark_verified(&tx, "requests", now_ms)?;
        }
        tx.commit()?;
        return Ok(0);
    }
    rollup::apply(&tx, &rows, TPS)?;
    rollup::advance(&tx, "requests", rows.last().unwrap().id, now_ms)?;
    tx.commit()?;
    Ok(rows.len())
}

const METRICS: [&str; 5] = [
    "memory_used_mib",
    "memory_total_mib",
    "utilization_percent",
    "temperature_c",
    "power_w",
];

fn metrics(s: &GpuSample) -> [f64; 5] {
    [
        s.memory_used_mib,
        s.memory_total_mib,
        s.utilization_percent,
        s.temperature_c,
        s.power_w,
    ]
}

/// Hourly per-GPU measurement summary. `last` follows the greatest (ts_ms, id).
#[derive(Clone, Debug, PartialEq)]
pub struct GpuHour {
    pub samples: i64,
    pub last_sample_ms: i64,
    last_id: i64,
    pub sum: [f64; 5],
    pub min: [f64; 5],
    pub max: [f64; 5],
    pub last: [f64; 5],
}

impl GpuHour {
    fn new(id: i64, s: &GpuSample) -> Self {
        let m = metrics(s);
        Self {
            samples: 0,
            last_sample_ms: s.ts,
            last_id: id,
            sum: [0.0; 5],
            min: m,
            max: m,
            last: m,
        }
    }

    fn add(&mut self, id: i64, s: &GpuSample) {
        let m = metrics(s);
        self.samples += 1;
        for (i, value) in m.into_iter().enumerate() {
            self.sum[i] += value;
            self.min[i] = self.min[i].min(value);
            self.max[i] = self.max[i].max(value);
        }
        if (s.ts, id) >= (self.last_sample_ms, self.last_id) {
            (self.last_sample_ms, self.last_id, self.last) = (s.ts, id, m);
        }
    }

    fn matches(&self, o: &GpuHour) -> bool {
        let close = |a: f64, b: f64| (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1.0);
        self.samples == o.samples
            && self.last_sample_ms == o.last_sample_ms
            && self.min == o.min
            && self.max == o.max
            && self.last == o.last
            && self.sum.iter().zip(o.sum).all(|(a, b)| close(*a, b))
    }
}

fn gpu_columns() -> String {
    let mut columns = vec!["bucket_ms", "gpu_index", "samples", "last_sample_ms"]
        .into_iter()
        .map(String::from)
        .collect::<Vec<_>>();
    for metric in METRICS {
        for suffix in ["sum", "min", "max", "last"] {
            columns.push(format!("{metric}_{suffix}"));
        }
    }
    columns.join(",")
}

fn gpu_hour(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<GpuHour> {
    let mut hour = GpuHour {
        samples: row.get(offset)?,
        last_sample_ms: row.get(offset + 1)?,
        last_id: 0,
        sum: [0.0; 5],
        min: [0.0; 5],
        max: [0.0; 5],
        last: [0.0; 5],
    };
    for i in 0..5 {
        hour.sum[i] = row.get(offset + 2 + 4 * i)?;
        hour.min[i] = row.get(offset + 3 + 4 * i)?;
        hour.max[i] = row.get(offset + 4 + 4 * i)?;
        hour.last[i] = row.get(offset + 5 + 4 * i)?;
    }
    Ok(hour)
}

fn gpu_rows(db: &Connection, sql: &str, value: i64) -> Result<Vec<(i64, GpuSample)>> {
    Ok(db
        .prepare_cached(sql)?
        .query_map([value], |r| Ok((r.get(0)?, storage::gpu(r)?)))?
        .collect::<rusqlite::Result<_>>()?)
}

fn group(samples: &[(i64, GpuSample)]) -> BTreeMap<(i64, u32), GpuHour> {
    let mut hours = BTreeMap::<(i64, u32), GpuHour>::new();
    for (id, s) in samples {
        hours
            .entry((rollup::floor(s.ts, HOUR_MS), s.index))
            .or_insert_with(|| GpuHour::new(*id, s))
            .add(*id, s);
    }
    hours
}

/// One GPU batch, or the one-time verification once caught up.
pub fn gpu_batch(db: &mut Connection, now_ms: i64) -> Result<usize> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let state = rollup::state(&tx, "gpu")?;
    let last = state.as_ref().map_or(0, |s| s.last_id);
    let samples = gpu_rows(
        &tx,
        &format!(
            "SELECT {} FROM gpu_samples WHERE id>?1 ORDER BY id LIMIT {}",
            storage::GPU_COLUMNS,
            rollup::BATCH
        ),
        last,
    )?;
    if samples.is_empty() {
        if state.as_ref().is_none_or(|s| s.verified_at_ms.is_none()) {
            rollup::advance(&tx, "gpu", last, now_ms)?;
            verify_gpu(&tx, last).context("GPU rollup verification")?;
            rollup::mark_verified(&tx, "gpu", now_ms)?;
        }
        tx.commit()?;
        return Ok(0);
    }
    let hours: Vec<_> = group(&samples).into_iter().collect();
    let columns = gpu_columns();
    let mut updates = vec![
        "samples=samples+excluded.samples".to_owned(),
        "last_sample_ms=MAX(last_sample_ms,excluded.last_sample_ms)".to_owned(),
    ];
    for metric in METRICS {
        // SET expressions all read the pre-update row. Later batches have
        // higher IDs, so an equal timestamp also takes the newer sample.
        updates.extend([
            format!("{metric}_sum={metric}_sum+excluded.{metric}_sum"),
            format!("{metric}_min=MIN({metric}_min,excluded.{metric}_min)"),
            format!("{metric}_max=MAX({metric}_max,excluded.{metric}_max)"),
            format!("{metric}_last=CASE WHEN excluded.last_sample_ms>=last_sample_ms THEN excluded.{metric}_last ELSE {metric}_last END"),
        ]);
    }
    for chunk in hours.chunks(32_766 / 24) {
        let tuple = format!("({})", vec!["?"; 24].join(","));
        let mut values = Vec::<Value>::with_capacity(chunk.len() * 24);
        for ((bucket, index), hour) in chunk {
            values.extend([
                (*bucket).into(),
                i64::from(*index).into(),
                hour.samples.into(),
                hour.last_sample_ms.into(),
            ]);
            for i in 0..5 {
                values.extend([
                    hour.sum[i].into(),
                    hour.min[i].into(),
                    hour.max[i].into(),
                    hour.last[i].into(),
                ]);
            }
        }
        tx.prepare_cached(&format!(
            "INSERT INTO gpu_hourly({columns}) VALUES {} ON CONFLICT(bucket_ms,gpu_index) DO UPDATE SET {}",
            vec![tuple.as_str(); chunk.len()].join(","),
            updates.join(",")
        ))?
        .execute(params_from_iter(values))?;
    }
    rollup::advance(&tx, "gpu", samples.last().unwrap().0, now_ms)?;
    tx.commit()?;
    Ok(samples.len())
}

/// Every hour/GPU summary equals the raw samples at or below the checkpoint,
/// from the first whole hour of retained raw samples: seven-day pruning (and
/// v1's ungated pruning before the upgrade) may have removed part of an older
/// hour. Runs before publication; pruning of rolled-up samples waits for it.
pub fn verify_gpu(db: &Connection, last_id: i64) -> Result<usize> {
    let first: i64 = db.query_row(
        "SELECT COALESCE(MIN(ts_ms),0) FROM gpu_samples WHERE id<=?1",
        [last_id],
        |r| r.get(0),
    )?;
    let from = rollup::ceil(first, HOUR_MS);
    let raw: Vec<_> = gpu_rows(
        db,
        &format!(
            "SELECT {} FROM gpu_samples WHERE id<=?1",
            storage::GPU_COLUMNS
        ),
        last_id,
    )?
    .into_iter()
    .filter(|(_, s)| s.ts >= from)
    .collect();
    let expected = group(&raw);
    let mut actual = BTreeMap::new();
    let mut statement = db.prepare(&format!(
        "SELECT {} FROM gpu_hourly WHERE bucket_ms>=?1",
        gpu_columns()
    ))?;
    let mut rows = statement.query([from])?;
    while let Some(row) = rows.next()? {
        actual.insert(
            (row.get::<_, i64>(0)?, row.get::<_, u32>(1)?),
            gpu_hour(row, 2)?,
        );
    }
    ensure!(
        expected.len() == actual.len(),
        "{} raw GPU hours, {} rollup rows",
        expected.len(),
        actual.len()
    );
    for (key, hour) in &expected {
        let row = actual
            .get(&(key.0, key.1))
            .with_context(|| format!("missing GPU hour {key:?}"))?;
        ensure!(
            row.matches(hour),
            "GPU hour {key:?}: {row:?} != raw {hour:?}"
        );
    }
    Ok(raw.len())
}

/// Bounded catch-up for both jobs. Caught up means an empty batch, which also
/// publishes the verified state the first time.
pub fn run(db: &mut Connection, now_ms: i64, batches: usize) -> Result<Progress> {
    let mut progress = Progress {
        caught_up: true,
        ..Default::default()
    };
    for job in [
        request_batch as fn(&mut Connection, i64) -> Result<usize>,
        gpu_batch,
    ] {
        let mut done = false;
        for _ in 0..batches {
            let rows = job(db, now_ms)?;
            if rows == 0 {
                done = true;
                break;
            }
            progress.batches += 1;
            progress.rows += rows;
        }
        progress.caught_up &= done;
    }
    progress.verified = ["requests", "gpu"].iter().try_fold(true, |all, job| {
        anyhow::Ok(all && rollup::state(db, job)?.is_some_and(|s| s.verified_at_ms.is_some()))
    })?;
    Ok(progress)
}

/// GPU history beyond raw retention: hourly means before `boundary`, as
/// `GpuSample`s with `samples` set. Parameters ?1 = first bucket, ?2 = boundary.
pub const GPU_HOURLY_SQL: &str = "SELECT bucket_ms,gpu_index,samples,memory_used_mib_sum,memory_total_mib_sum,utilization_percent_sum,temperature_c_sum,power_w_sum FROM gpu_hourly WHERE bucket_ms>=?1 AND bucket_ms<?2 AND EXISTS(SELECT 1 FROM rollup_state WHERE job='gpu' AND verified_at_ms IS NOT NULL)";

/// A GPU history point: a raw sample, or an hourly mean when `samples` is set.
#[derive(Debug, Clone, serde::Serialize, utoipa::ToSchema)]
pub struct GpuPoint {
    #[serde(flatten)]
    pub sample: GpuSample,
    /// Hourly rollup only: measurements averaged into this point; `ts` is the
    /// UTC hour start. Absent for raw samples.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub samples: Option<u64>,
}

pub fn gpu_hourly_point(row: &rusqlite::Row<'_>) -> rusqlite::Result<GpuPoint> {
    let samples: i64 = row.get(2)?;
    let mean = |i| -> rusqlite::Result<f64> { Ok(row.get::<_, f64>(i)? / samples as f64) };
    Ok(GpuPoint {
        sample: GpuSample {
            ts: row.get(0)?,
            index: row.get(1)?,
            memory_used_mib: mean(3)?,
            memory_total_mib: mean(4)?,
            utilization_percent: mean(5)?,
            temperature_c: mean(6)?,
            power_w: mean(7)?,
        },
        samples: Some(samples as u64),
    })
}

/// Raw GPU samples from `boundary`, plus unrolled samples since `since`.
/// Parameters ?1 = since, ?2 = boundary. Disjoint from the hourly rows by ID.
pub fn gpu_raw_sql() -> String {
    let last = rollup::verified_last("gpu");
    format!(
        "SELECT {c} FROM gpu_samples INDEXED BY gpu_ts WHERE ts_ms>=?2
         UNION ALL SELECT {c} FROM gpu_samples WHERE id>{last} AND ts_ms>=?1 AND ts_ms<?2",
        c = storage::GPU_COLUMNS
    )
}

/// Raw requests are kept 365 days; strictly older rows are pruned (MET-206).
pub const REQUEST_RETENTION_MS: i64 = 365 * 86_400_000;
/// Rows per retention statement. Each batch is its own writer job, so
/// ingestion interleaves between batches.
pub const PRUNE_BATCH: usize = 2_000;
pub const PRUNE_BATCHES_PER_RUN: usize = 50;

#[derive(Debug, PartialEq, Eq)]
pub enum Prune {
    /// No request is older than the cutoff.
    Nothing,
    /// A gate is unmet; nothing was deleted.
    Refused(String),
    Deleted(usize),
}

/// One bounded retention batch. Deletes requests with `ts_ms < cutoff_ms`
/// only when every such row is inside the verified request rollup, so stats
/// for every range stay identical. Late rows above the checkpoint wait.
pub fn prune_requests(db: &mut Connection, cutoff_ms: i64) -> Result<Prune> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let Some(expired) = tx.query_row(
        "SELECT MAX(id) FROM requests INDEXED BY requests_ts WHERE ts_ms<?1",
        [cutoff_ms],
        |r| r.get::<_, Option<i64>>(0),
    )?
    else {
        return Ok(Prune::Nothing);
    };
    match rollup::state(&tx, "requests")? {
        Some(s) if s.verified_at_ms.is_some() && s.last_id >= expired => {}
        Some(s) if s.verified_at_ms.is_some() => {
            return Ok(Prune::Refused(format!(
                "rollup behind: expired request id {expired} is above the verified checkpoint {}",
                s.last_id
            )));
        }
        _ => {
            return Ok(Prune::Refused(
                "rollup unverified: the request rollup has not passed its raw comparison".into(),
            ));
        }
    }
    let deleted = tx.execute(
        "DELETE FROM requests WHERE id IN (SELECT id FROM requests INDEXED BY requests_ts WHERE ts_ms<?1 AND id<=?2 LIMIT ?3)",
        params![cutoff_ms, expired, PRUNE_BATCH as i64],
    )?;
    tx.commit()?;
    Ok(Prune::Deleted(deleted))
}

/// Seven-day raw deletion, restricted to verified rolled-up samples.
pub fn prune_gpu(db: &Connection, now_ms: i64) -> Result<usize> {
    Ok(db.execute(
        &format!(
            "DELETE FROM gpu_samples WHERE ts_ms<?1 AND id<={}",
            rollup::verified_last("gpu")
        ),
        params![now_ms - 7 * 86_400_000],
    )?)
}
