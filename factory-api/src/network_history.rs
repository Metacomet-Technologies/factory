//! Network probe storage. Raw bursts and their hourly rollups commit together.
use crate::network::{Burst, Layer, Rtt, Sample};
use crate::ups_history::{DAY_MS, HOUR_MS};
use anyhow::{Result, ensure};
use rusqlite::{
    Connection, OptionalExtension, Row, ToSql, params,
    types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, ValueRef},
};
use serde::Serialize;
use std::collections::BTreeMap;
use utoipa::ToSchema;

impl ToSql for Layer {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(self.as_str().into())
    }
}
impl FromSql for Layer {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        Layer::parse(value.as_str()?).ok_or(FromSqlError::InvalidType)
    }
}

macro_rules! columns {
    () => {
        "ts_ms,layer,target,address,sent,received,rtt_min_us,rtt_avg_us,rtt_max_us,rtt_mdev_us"
    };
}
fn sample(row: &Row<'_>) -> rusqlite::Result<Sample> {
    let min_us: Option<i64> = row.get(6)?;
    Ok(Sample {
        ts_ms: row.get(0)?,
        layer: row.get(1)?,
        target: row.get(2)?,
        address: row.get(3)?,
        burst: Burst {
            sent: row.get(4)?,
            received: row.get(5)?,
            rtt: match min_us {
                Some(min_us) => Some(Rtt {
                    min_us,
                    avg_us: row.get(7)?,
                    max_us: row.get(8)?,
                    mdev_us: row.get(9)?,
                }),
                None => None,
            },
        },
    })
}

/// The hour's rollup from its raw bursts. Average RTT is weighted by replies;
/// jitter is the nearest-rank p95 of the bursts' mdev values.
#[derive(Debug, PartialEq, Eq)]
pub struct HourRollup {
    pub sample_count: i64,
    pub sent: i64,
    pub received: i64,
    pub rtt_min_us: Option<i64>,
    pub rtt_avg_us: Option<i64>,
    pub rtt_max_us: Option<i64>,
    pub rtt_mdev_p95_us: Option<i64>,
}
pub fn rollup(bursts: &[Burst]) -> HourRollup {
    let replied: Vec<(i64, Rtt)> = bursts
        .iter()
        .filter_map(|b| b.rtt.map(|rtt| (i64::from(b.received), rtt)))
        .collect();
    let received: i64 = replied.iter().map(|(n, _)| n).sum();
    let mut mdev: Vec<i64> = replied.iter().map(|(_, rtt)| rtt.mdev_us).collect();
    mdev.sort_unstable();
    let weighted: i64 = replied.iter().map(|(n, rtt)| n * rtt.avg_us).sum();
    HourRollup {
        sample_count: bursts.len() as i64,
        sent: bursts.iter().map(|b| i64::from(b.sent)).sum(),
        received,
        rtt_min_us: replied.iter().map(|(_, rtt)| rtt.min_us).min(),
        rtt_avg_us: (received > 0).then(|| (weighted + received / 2) / received),
        rtt_max_us: replied.iter().map(|(_, rtt)| rtt.max_us).max(),
        rtt_mdev_p95_us: (!mdev.is_empty()).then(|| mdev[(mdev.len() * 95).div_ceil(100) - 1]),
    }
}

pub const PREVIOUS_SQL: &str = concat!(
    "SELECT ",
    columns!(),
    " FROM net_probe_samples WHERE device_id=?1 AND target=?2 ORDER BY ts_ms DESC LIMIT 1"
);
pub const HOUR_SQL: &str = concat!(
    "SELECT ",
    columns!(),
    " FROM net_probe_samples WHERE device_id=?1 AND target=?2 AND ts_ms>=?3 AND ts_ms<?4"
);
/// Write one tick in one transaction: the raw rows plus every touched hourly
/// rollup, recomputed from that hour's raw rows (at most 120 per target).
/// Replaying an already committed tick is a no-op; an older or conflicting
/// timestamp for a target is rejected.
pub fn record(db: &mut Connection, device_id: &str, samples: &[Sample]) -> Result<()> {
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    {
        let mut previous = tx.prepare_cached(PREVIOUS_SQL)?;
        let mut insert = tx.prepare_cached(concat!(
            "INSERT INTO net_probe_samples(device_id,",
            columns!(),
            ") VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)"
        ))?;
        let mut hour = tx.prepare_cached(HOUR_SQL)?;
        let mut upsert = tx.prepare_cached(
            "INSERT OR REPLACE INTO net_probe_rollup_hourly VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        )?;
        for s in samples {
            if let Some(last) = previous
                .query_row(params![device_id, s.target], sample)
                .optional()?
            {
                if last == *s {
                    continue;
                }
                ensure!(
                    s.ts_ms > last.ts_ms,
                    "network sample for {} did not advance",
                    s.target
                );
            }
            let rtt = s.burst.rtt;
            insert.execute(params![
                device_id,
                s.ts_ms,
                s.layer,
                s.target,
                s.address,
                s.burst.sent,
                s.burst.received,
                rtt.map(|r| r.min_us),
                rtt.map(|r| r.avg_us),
                rtt.map(|r| r.max_us),
                rtt.map(|r| r.mdev_us),
            ])?;
            let start = s.ts_ms / HOUR_MS * HOUR_MS;
            let bursts = hour
                .query_map(params![device_id, s.target, start, start + HOUR_MS], |r| {
                    Ok(sample(r)?.burst)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let r = rollup(&bursts);
            upsert.execute(params![
                device_id,
                start,
                s.target,
                s.layer,
                r.sample_count,
                r.sent,
                r.received,
                r.rtt_min_us,
                r.rtt_avg_us,
                r.rtt_max_us,
                r.rtt_mdev_p95_us,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub const RETAIN_SQL: &str = "DELETE FROM net_probe_samples WHERE rowid IN (SELECT rowid FROM net_probe_samples WHERE ts_ms<?1 ORDER BY ts_ms LIMIT 1000) AND EXISTS(SELECT 1 FROM net_probe_rollup_hourly r WHERE r.device_id=net_probe_samples.device_id AND r.ts_ms=net_probe_samples.ts_ms/3600000*3600000 AND r.target=net_probe_samples.target)";
/// Raw bursts older than seven days go, at most 1000 per maintenance tick,
/// and only where their committed hourly rollup exists.
pub fn retain(db: &mut Connection, now: i64) -> Result<usize> {
    let tx = db.transaction()?;
    let count = tx.execute(RETAIN_SQL, [(now - 7 * DAY_MS).max(0)])?;
    tx.commit()?;
    Ok(count)
}

pub const LATEST_SQL: &str = "SELECT s.ts_ms,s.layer,s.target,s.address,s.sent,s.received,s.rtt_min_us,s.rtt_avg_us,s.rtt_max_us,s.rtt_mdev_us FROM json_each(?2) k JOIN net_probe_samples s ON s.rowid=(SELECT rowid FROM net_probe_samples WHERE device_id=?1 AND target=k.value ORDER BY ts_ms DESC LIMIT 1)";
/// Latest sample for each of the given targets, in one bounded statement.
pub fn latest(db: &Connection, device_id: &str, targets: &[String]) -> Result<Vec<Sample>> {
    Ok(db
        .prepare(LATEST_SQL)?
        .query_map(params![device_id, serde_json::to_string(targets)?], sample)?
        .collect::<rusqlite::Result<_>>()?)
}

#[derive(Debug, Serialize, ToSchema)]
pub struct NetworkLatency {
    pub min: Option<f64>,
    pub avg: Option<f64>,
    pub max: Option<f64>,
}
#[derive(Debug, Serialize, ToSchema)]
pub struct NetworkPoint {
    pub ts_ms: i64,
    pub sample_count: i64,
    pub loss_percent: f64,
    /// Average is weighted by received replies. Null when nothing came back.
    pub latency_ms: NetworkLatency,
    /// Raw buckets: mean of the bursts' mdev. Hourly points: nearest-rank p95.
    pub jitter_ms: Option<f64>,
}
#[derive(Debug, Serialize, ToSchema)]
pub struct NetworkSeries {
    pub layer: Layer,
    pub target: String,
    pub points: Vec<NetworkPoint>,
}
pub const RAW_HISTORY_SQL: &str = "SELECT layer,target,MIN(ts_ms),COUNT(*),SUM(sent),SUM(received),MIN(rtt_min_us),(SUM(rtt_avg_us*received)+SUM(received)/2)/SUM(received),MAX(rtt_max_us),AVG(rtt_mdev_us) FROM net_probe_samples WHERE device_id=?1 AND ts_ms>=?2 AND ts_ms<=?3 GROUP BY target,(ts_ms-?2)/?4 ORDER BY target,(ts_ms-?2)/?4";
pub const HOURLY_HISTORY_SQL: &str = "SELECT layer,target,ts_ms,sample_count,sent,received,rtt_min_us,rtt_avg_us,rtt_max_us,rtt_mdev_p95_us FROM net_probe_rollup_hourly WHERE device_id=?1 AND ts_ms>=?2 AND ts_ms<=?3 ORDER BY ts_ms,target";
/// Raw ranges use at most 720 buckets per target; longer ranges read hourly
/// rollups, including the hour that overlaps the start. Series are ordered by
/// layer, then target.
pub fn history(
    db: &Connection,
    device_id: &str,
    since: i64,
    now: i64,
    raw: bool,
) -> Result<Vec<NetworkSeries>> {
    let mut statement = db.prepare(if raw {
        RAW_HISTORY_SQL
    } else {
        HOURLY_HISTORY_SQL
    })?;
    let width = (now - since + 1 + 719) / 720;
    let first_hour = since / HOUR_MS * HOUR_MS;
    let mut rows = if raw {
        statement.query(params![device_id, since, now, width])?
    } else {
        statement.query(params![device_id, first_hour, now])?
    };
    let mut series = BTreeMap::<(Layer, String), Vec<NetworkPoint>>::new();
    let ms = |us: Option<f64>| us.map(|us| us / 1000.0);
    while let Some(r) = rows.next()? {
        let (sent, received): (i64, i64) = (r.get(4)?, r.get(5)?);
        let jitter_us: Option<f64> = r.get(9)?;
        let point = NetworkPoint {
            ts_ms: r.get(2)?,
            sample_count: r.get(3)?,
            loss_percent: 100.0 * (sent - received) as f64 / sent as f64,
            latency_ms: NetworkLatency {
                min: ms(r.get(6)?),
                avg: ms(r.get(7)?),
                max: ms(r.get(8)?),
            },
            jitter_ms: ms(jitter_us),
        };
        series
            .entry((r.get(0)?, r.get(1)?))
            .or_default()
            .push(point);
    }
    Ok(series
        .into_iter()
        .map(|((layer, target), points)| NetworkSeries {
            layer,
            target,
            points,
        })
        .collect())
}
