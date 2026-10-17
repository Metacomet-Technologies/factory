//! Network storage. Raw bursts, their hourly rollups and the diagnosed
//! episodes commit together; throughput tests are one row each.
use crate::network::{Burst, Layer, Rtt, Sample};
use crate::network_diagnosis::{self, Diagnosis, LinkState, Peak, Reason, Thresholds};
use crate::network_speed::{SpeedTest, Verdict};
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
impl ToSql for Reason {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(self.as_str().into())
    }
}
impl FromSql for Reason {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        Reason::parse(value.as_str()?).ok_or(FromSqlError::InvalidType)
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
/// Write one tick in one transaction: the raw rows, every touched hourly
/// rollup, recomputed from that hour's raw rows (at most 120 per target), and
/// the episode the tick's diagnosis implies. Returns the events it closed or
/// opened. Replaying an already committed tick is a no-op; an older or
/// conflicting timestamp for a target is rejected.
pub fn record(
    db: &mut Connection,
    device_id: &str,
    samples: &[Sample],
    diagnosed: Option<&Diagnosed>,
) -> Result<Vec<NetworkEvent>> {
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
    let events = match diagnosed {
        Some(tick) => record_event(&tx, device_id, tick)?,
        None => Vec::new(),
    };
    tx.commit()?;
    Ok(events)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum NetworkEndReason {
    Recovered,
    /// The link moved straight to another degraded or down state.
    Changed,
    /// factory-api restarted, so the episode's continuity is unknown.
    Restart,
}
impl NetworkEndReason {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Recovered => "recovered",
            Self::Changed => "changed",
            Self::Restart => "restart",
        }
    }
}
impl ToSql for NetworkEndReason {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(self.as_str().into())
    }
}
impl FromSql for NetworkEndReason {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let text = value.as_str()?;
        [Self::Recovered, Self::Changed, Self::Restart]
            .into_iter()
            .find(|r| r.as_str() == text)
            .ok_or(FromSqlError::InvalidType)
    }
}
/// One degraded or down episode. `state`, `layer` and `reason` are the link
/// state it records; it is never healthy.
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
pub struct NetworkEvent {
    pub id: i64,
    #[serde(flatten)]
    pub state: LinkState,
    pub started_ms: i64,
    /// Null while the episode is open.
    pub ended_ms: Option<i64>,
    pub end_reason: Option<NetworkEndReason>,
    /// Peaks over the faulting layer's chosen targets while the episode lasted.
    pub peak_loss_percent: Option<f64>,
    /// Average RTT; null while nothing came back.
    pub peak_rtt_us: Option<i64>,
    pub peak_mdev_us: Option<i64>,
}
macro_rules! event_columns {
    () => {
        "id,state,layer,reason,started_ms,ended_ms,end_reason,peak_loss_percent,peak_rtt_us,peak_mdev_us"
    };
}
fn event(row: &Row<'_>) -> rusqlite::Result<NetworkEvent> {
    let layer = row.get(2)?;
    let state = match (row.get_ref(1)?.as_str()?, row.get(3)?) {
        ("down", None) => LinkState::Down { layer },
        ("degraded", Some(reason)) => LinkState::Degraded { layer, reason },
        _ => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Text,
                "network event state and reason disagree".into(),
            ));
        }
    };
    Ok(NetworkEvent {
        id: row.get(0)?,
        state,
        started_ms: row.get(4)?,
        ended_ms: row.get(5)?,
        end_reason: row.get(6)?,
        peak_loss_percent: row.get(7)?,
        peak_rtt_us: row.get(8)?,
        peak_mdev_us: row.get(9)?,
    })
}

/// What one tick concluded about the link, stored with its samples.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Diagnosed {
    pub ts_ms: i64,
    pub state: LinkState,
    /// The faulting layer's peak this tick; null when healthy.
    pub peak: Option<Peak>,
    /// Set until this process commits a tick: an open event that started
    /// earlier was left by a previous process.
    pub restart: bool,
}
/// The network collector's memory between ticks.
#[derive(Debug, Clone, Copy, Default)]
pub struct Collector {
    diagnosis: Diagnosis,
    committed: bool,
}
impl Collector {
    /// Diagnose one tick. Streaks follow the probes even when the write then
    /// fails; the next committed tick reconciles the stored episode.
    pub fn diagnose(
        &mut self,
        ts_ms: i64,
        samples: &[Sample],
        thresholds: &Thresholds,
    ) -> Diagnosed {
        let readings = network_diagnosis::assess(samples, thresholds);
        self.diagnosis = network_diagnosis::step(&self.diagnosis, &readings.map(|r| r.health));
        let state = self.diagnosis.state;
        Diagnosed {
            ts_ms,
            state,
            peak: state
                .layer()
                .and_then(|layer| readings[layer as usize].peak),
            restart: !self.committed,
        }
    }
    pub fn committed(&mut self) {
        self.committed = true;
    }
}

pub const OPEN_EVENT_SQL: &str = concat!(
    "SELECT ",
    event_columns!(),
    " FROM net_events WHERE device_id=?1 AND ended_ms IS NULL"
);
pub fn open_event(db: &Connection, device_id: &str) -> Result<Option<NetworkEvent>> {
    Ok(db
        .prepare_cached(OPEN_EVENT_SQL)?
        .query_row([device_id], event)
        .optional()?)
}
fn close_event(
    tx: &Connection,
    open: NetworkEvent,
    ts_ms: i64,
    reason: NetworkEndReason,
) -> Result<NetworkEvent> {
    tx.prepare_cached("UPDATE net_events SET ended_ms=?2,end_reason=?3 WHERE id=?1")?
        .execute(params![open.id, ts_ms, reason])?;
    Ok(NetworkEvent {
        ended_ms: Some(ts_ms),
        end_reason: Some(reason),
        ..open
    })
}
/// Bring the stored open episode in line with this tick's state, judged
/// against what is stored rather than the previous tick, so a replay changes
/// nothing and a tick after failed writes still converges.
fn record_event(tx: &Connection, device_id: &str, tick: &Diagnosed) -> Result<Vec<NetworkEvent>> {
    let mut changed = Vec::new();
    let mut open = open_event(tx, device_id)?;
    if let Some(event) = &open {
        ensure!(
            tick.ts_ms >= event.started_ms,
            "network event did not advance"
        );
    }
    if tick.restart
        && let Some(event) = open.take_if(|e| e.started_ms < tick.ts_ms)
    {
        changed.push(close_event(
            tx,
            event,
            tick.ts_ms,
            NetworkEndReason::Restart,
        )?);
    }
    match open {
        Some(event) if event.state == tick.state => {
            let Some(peak) = tick.peak else {
                return Ok(changed);
            };
            let loss = event
                .peak_loss_percent
                .map_or(peak.loss_percent, |l| l.max(peak.loss_percent));
            let (rtt, mdev) = (
                event.peak_rtt_us.max(peak.rtt_us),
                event.peak_mdev_us.max(peak.mdev_us),
            );
            if (Some(loss), rtt, mdev)
                != (
                    event.peak_loss_percent,
                    event.peak_rtt_us,
                    event.peak_mdev_us,
                )
            {
                tx.prepare_cached("UPDATE net_events SET peak_loss_percent=?2,peak_rtt_us=?3,peak_mdev_us=?4 WHERE id=?1")?
                    .execute(params![event.id, loss, rtt, mdev])?;
            }
            return Ok(changed);
        }
        Some(event) => {
            let reason = if tick.state == LinkState::Healthy {
                NetworkEndReason::Recovered
            } else {
                NetworkEndReason::Changed
            };
            changed.push(close_event(tx, event, tick.ts_ms, reason)?);
        }
        None => {}
    }
    let (state, layer, reason) = match tick.state {
        LinkState::Healthy => return Ok(changed),
        LinkState::Degraded { layer, reason } => ("degraded", layer, Some(reason)),
        LinkState::Down { layer } => ("down", layer, None),
    };
    let peak = tick.peak;
    changed.push(
        tx.prepare_cached(concat!(
            "INSERT INTO net_events(device_id,state,layer,reason,started_ms,peak_loss_percent,peak_rtt_us,peak_mdev_us) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) RETURNING ",
            event_columns!()
        ))?
        .query_row(
            params![
                device_id,
                state,
                layer,
                reason,
                tick.ts_ms,
                peak.map(|p| p.loss_percent),
                peak.and_then(|p| p.rtt_us),
                peak.and_then(|p| p.mdev_us),
            ],
            event,
        )?,
    );
    Ok(changed)
}

#[derive(Debug, Serialize, ToSchema)]
pub struct NetworkEvents {
    /// Newest first: started_ms descending, then id descending.
    pub events: Vec<NetworkEvent>,
    /// The last event's id, to pass as `before` for the next page; null on the last page.
    pub next_before: Option<i64>,
}
pub const EVENT_CURSOR_SQL: &str = "SELECT started_ms FROM net_events WHERE id=?1 AND device_id=?2";
pub const EVENTS_SQL: &str = concat!(
    "SELECT ",
    event_columns!(),
    " FROM net_events WHERE device_id=?1 AND (started_ms,id)<(?2,?3) ORDER BY started_ms DESC,id DESC LIMIT ?4"
);
/// A newest-first page by (started_ms, id) that starts after the `before`
/// event, or at the newest without one. None when `before` names no event of
/// this device.
pub fn events(
    db: &Connection,
    device_id: &str,
    limit: u32,
    before: Option<i64>,
) -> Result<Option<NetworkEvents>> {
    ensure!((1..=200).contains(&limit), "limit must be 1–200");
    let (before_ms, before_id) = match before {
        None => (i64::MAX, i64::MAX),
        Some(id) => {
            let started_ms = db
                .prepare_cached(EVENT_CURSOR_SQL)?
                .query_row(params![id, device_id], |r| r.get(0))
                .optional()?;
            let Some(started_ms) = started_ms else {
                return Ok(None);
            };
            (started_ms, id)
        }
    };
    let events = db
        .prepare_cached(EVENTS_SQL)?
        .query_map(params![device_id, before_ms, before_id, limit], event)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let next_before = events
        .last()
        .filter(|_| events.len() == limit as usize)
        .map(|e| e.id);
    Ok(Some(NetworkEvents {
        events,
        next_before,
    }))
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
    /// Average is weighted by received replies; all null when nothing came back.
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum NetworkSpeedOutcome {
    Ok,
    Failed,
    Timeout,
}
impl NetworkSpeedOutcome {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Failed => "failed",
            Self::Timeout => "timeout",
        }
    }
}
impl ToSql for NetworkSpeedOutcome {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(self.as_str().into())
    }
}
impl FromSql for NetworkSpeedOutcome {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let text = value.as_str()?;
        [Self::Ok, Self::Failed, Self::Timeout]
            .into_iter()
            .find(|o| o.as_str() == text)
            .ok_or(FromSqlError::InvalidType)
    }
}
/// One stored throughput test. Rates are bits per second; latencies are average RTT to the first wan target.
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
pub struct NetworkSpeedTest {
    pub id: i64,
    pub started_ms: i64,
    pub ended_ms: i64,
    pub outcome: NetworkSpeedOutcome,
    /// Always set for failed tests.
    pub error: Option<String>,
    /// Nearest-rank p90 of per-request rates; null unless the outcome is ok.
    pub download_bps: Option<i64>,
    pub upload_bps: Option<i64>,
    /// Bytes moved, for every outcome.
    pub download_bytes: i64,
    pub upload_bytes: i64,
    /// One burst before the transfers.
    pub idle_latency_ms: Option<f64>,
    /// Bursts run while that direction transferred.
    pub download_loaded_latency_ms: Option<f64>,
    pub upload_loaded_latency_ms: Option<f64>,
    /// Cloudflare colo code. The public IP is never stored.
    pub colo: Option<String>,
}
macro_rules! speed_columns {
    () => {
        "id,started_ms,ended_ms,outcome,error,download_bps,upload_bps,download_bytes,upload_bytes,idle_latency_us,download_loaded_latency_us,upload_loaded_latency_us,colo"
    };
}
fn speed_test(row: &Row<'_>) -> rusqlite::Result<NetworkSpeedTest> {
    let ms = |i: usize| -> rusqlite::Result<Option<f64>> {
        Ok(row.get::<_, Option<i64>>(i)?.map(|us| us as f64 / 1000.0))
    };
    Ok(NetworkSpeedTest {
        id: row.get(0)?,
        started_ms: row.get(1)?,
        ended_ms: row.get(2)?,
        outcome: row.get(3)?,
        error: row.get(4)?,
        download_bps: row.get(5)?,
        upload_bps: row.get(6)?,
        download_bytes: row.get(7)?,
        upload_bytes: row.get(8)?,
        idle_latency_ms: ms(9)?,
        download_loaded_latency_ms: ms(10)?,
        upload_loaded_latency_ms: ms(11)?,
        colo: row.get(12)?,
    })
}
/// Insert one test and return the row as stored.
pub fn record_speed_test(
    db: &mut Connection,
    device_id: &str,
    test: &SpeedTest,
) -> Result<NetworkSpeedTest> {
    let (outcome, error, download_bps, upload_bps) = match &test.verdict {
        Verdict::Ok {
            download_bps,
            upload_bps,
        } => (
            NetworkSpeedOutcome::Ok,
            None,
            Some(*download_bps),
            Some(*upload_bps),
        ),
        Verdict::Failed(error) => (
            NetworkSpeedOutcome::Failed,
            Some(error.as_str()),
            None,
            None,
        ),
        Verdict::Timeout => (NetworkSpeedOutcome::Timeout, None, None, None),
    };
    Ok(db
        .prepare_cached(concat!(
            "INSERT INTO net_speed_tests(device_id,started_ms,ended_ms,outcome,error,download_bps,upload_bps,download_bytes,upload_bytes,idle_latency_us,download_loaded_latency_us,upload_loaded_latency_us,colo) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) RETURNING ",
            speed_columns!()
        ))?
        .query_row(
            params![
                device_id,
                test.started_ms,
                test.ended_ms,
                outcome,
                error,
                download_bps,
                upload_bps,
                test.download_bytes,
                test.upload_bytes,
                test.idle_latency_us,
                test.download_loaded_latency_us,
                test.upload_loaded_latency_us,
                test.colo,
            ],
            speed_test,
        )?)
}

pub const SPEED_RETENTION_MS: i64 = 365 * DAY_MS;
/// A skip-scan over the few device ids keeps every step an index search.
pub const SPEED_RETAIN_SQL: &str = "DELETE FROM net_speed_tests WHERE id IN (WITH RECURSIVE device(id) AS (SELECT MIN(device_id) FROM net_speed_tests UNION ALL SELECT (SELECT MIN(device_id) FROM net_speed_tests WHERE device_id>device.id) FROM device WHERE device.id IS NOT NULL) SELECT t.id FROM device JOIN net_speed_tests t ON t.device_id=device.id AND t.started_ms<?1 LIMIT 1000)";
/// Tests that started more than 365 days ago go, at most 1000 per maintenance tick.
pub fn retain_speed_tests(db: &mut Connection, now: i64) -> Result<usize> {
    Ok(db.execute(SPEED_RETAIN_SQL, [(now - SPEED_RETENTION_MS).max(0)])?)
}
pub const LATEST_SPEED_SQL: &str = concat!(
    "SELECT ",
    speed_columns!(),
    " FROM net_speed_tests WHERE device_id=?1 ORDER BY started_ms DESC, id DESC LIMIT 1"
);
pub fn latest_speed_test(db: &Connection, device_id: &str) -> Result<Option<NetworkSpeedTest>> {
    Ok(db
        .prepare_cached(LATEST_SPEED_SQL)?
        .query_row([device_id], speed_test)
        .optional()?)
}
pub const SPEED_TESTS_SQL: &str = concat!(
    "SELECT ",
    speed_columns!(),
    " FROM net_speed_tests WHERE device_id=?1 AND started_ms>=?2 ORDER BY started_ms, id"
);
/// Tests that started at or after `since`, oldest first.
pub fn speed_tests(db: &Connection, device_id: &str, since: i64) -> Result<Vec<NetworkSpeedTest>> {
    Ok(db
        .prepare_cached(SPEED_TESTS_SQL)?
        .query_map(params![device_id, since], speed_test)?
        .collect::<rusqlite::Result<_>>()?)
}
