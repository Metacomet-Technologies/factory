//! UPS-owned storage. Readings, summaries and event transitions commit together.
use crate::ups::UpsCurrent;
use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

pub const HOUR_MS: i64 = 3_600_000;
pub const DAY_MS: i64 = 24 * HOUR_MS;
const KEYS: [&str; 2] = [
    "ups.electricity_rate_micro_usd_per_kwh",
    "ups.battery_installed_ms",
];

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct UpsSettings {
    #[serde(deserialize_with = "Deserialize::deserialize")]
    #[schema(required = true, minimum = 0, maximum = 10000000)]
    pub electricity_rate_micro_usd_per_kwh: Option<i64>,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    #[schema(required = true, minimum = 0)]
    pub battery_installed_ms: Option<i64>,
}
impl UpsSettings {
    pub fn validate(&self, now: i64) -> Result<()> {
        ensure!(
            self.electricity_rate_micro_usd_per_kwh
                .is_none_or(|v| (0..=10_000_000).contains(&v)),
            "rate must be 0–10000000 micro USD/kWh or null"
        );
        ensure!(
            self.battery_installed_ms
                .is_none_or(|v| (0..=now).contains(&v)),
            "battery date must be a nonnegative UTC millisecond timestamp, not in the future"
        );
        Ok(())
    }
}
pub fn settings(db: &Connection) -> Result<UpsSettings> {
    let values = factory_db::settings::integers(db, &KEYS)?;
    Ok(UpsSettings {
        electricity_rate_micro_usd_per_kwh: values[0],
        battery_installed_ms: values[1],
    })
}
pub fn put_settings(db: &Connection, values: UpsSettings, now: i64) -> Result<UpsSettings> {
    values.validate(now)?;
    factory_db::settings::put_integers(
        db,
        &[
            (KEYS[0], values.electricity_rate_micro_usd_per_kwh),
            (KEYS[1], values.battery_installed_ms),
        ],
    )?;
    Ok(values)
}

/// Quantize watts to milliwatts, then integrate with checked integer math.
/// Round half-up once to stored mWh. A missing reading or >30s gap adds no energy.
pub fn sample_energy(load_w: Option<f64>, elapsed_ms: i64) -> Result<i64> {
    if !(1..=30_000).contains(&elapsed_ms) {
        return Ok(0);
    }
    let Some(watts) = load_w else {
        return Ok(0);
    };
    let mw = (watts * 1000.0).round();
    ensure!(
        mw.is_finite() && mw >= 0.0 && mw < i64::MAX as f64,
        "power outside integer range"
    );
    let numerator = i128::from(mw as i64)
        .checked_mul(i128::from(elapsed_ms))
        .ok_or_else(|| anyhow::anyhow!("energy overflow"))?;
    Ok(i64::try_from((numerator + 1_800_000) / 3_600_000)?)
}
/// mWh × micro USD/kWh / 1000 = nano USD. Half-up once per requested range.
pub fn cost(energy_mwh: i64, rate: i64) -> Result<i64> {
    ensure!(energy_mwh >= 0 && rate >= 0, "negative energy or rate");
    let numerator = i128::from(energy_mwh)
        .checked_mul(i128::from(rate))
        .and_then(|n| n.checked_add(500))
        .ok_or_else(|| anyhow::anyhow!("cost overflow"))?;
    Ok(i64::try_from(numerator / 1000)?)
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct UpsEvent {
    pub id: i64,
    pub kind: String,
    pub started_ms: i64,
    pub ended_ms: Option<i64>,
    pub min_charge_percent: Option<f64>,
    pub min_runtime_s: Option<i64>,
    pub detail: Option<String>,
    pub end_reason: Option<String>,
}
fn event(row: &Row<'_>) -> rusqlite::Result<UpsEvent> {
    Ok(UpsEvent {
        id: row.get(0)?,
        kind: row.get(1)?,
        started_ms: row.get(2)?,
        ended_ms: row.get(3)?,
        min_charge_percent: row.get(4)?,
        min_runtime_s: row.get(5)?,
        detail: row.get(6)?,
        end_reason: row.get(7)?,
    })
}
/// Include the event spanning the alert's start, plus all later restart segments.
/// Both branches use ups_events_started; history before the outage is not loaded.
pub const ALERT_EVENTS_SQL: &str = "SELECT id,kind,started_ms,ended_ms,min_charge_percent,min_runtime_s,detail,end_reason FROM ups_events WHERE kind='on_battery' AND started_ms>=?1 UNION ALL SELECT id,kind,started_ms,ended_ms,min_charge_percent,min_runtime_s,detail,end_reason FROM ups_events WHERE id=(SELECT id FROM ups_events WHERE kind='on_battery' AND started_ms<?1 ORDER BY started_ms DESC,id DESC LIMIT 1) AND (ended_ms IS NULL OR ended_ms>=?1)";
pub fn alert_events(db: &Connection, since: i64) -> Result<Vec<UpsEvent>> {
    Ok(db
        .prepare(ALERT_EVENTS_SQL)?
        .query_map([since], event)?
        .collect::<rusqlite::Result<_>>()?)
}
#[derive(Debug, Serialize, ToSchema)]
pub struct UpsEvents {
    pub events: Vec<UpsEvent>,
    /// Pass both cursor fields to avoid skipping simultaneous transitions.
    pub next_before_ms: Option<i64>,
    pub next_before_id: Option<i64>,
}
pub const EVENTS_SQL: &str = "SELECT id,kind,started_ms,ended_ms,min_charge_percent,min_runtime_s,detail,end_reason FROM ups_events WHERE (started_ms,id)<(?1,?2) ORDER BY started_ms DESC,id DESC LIMIT ?3";
pub fn events(db: &Connection, limit: u32, before_ms: i64, before_id: i64) -> Result<UpsEvents> {
    ensure!((1..=200).contains(&limit), "limit must be 1–200");
    let events = db
        .prepare(EVENTS_SQL)?
        .query_map(params![before_ms, before_id, limit], event)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let last = events.last().filter(|_| events.len() == limit as usize);
    Ok(UpsEvents {
        next_before_ms: last.map(|e| e.started_ms),
        next_before_id: last.map(|e| e.id),
        events,
    })
}

#[derive(Clone)]
pub struct Collector {
    last_success_ms: i64,
    restart_ids: Vec<i64>,
    test_result: Option<String>,
}
impl Collector {
    pub fn new(db: &Connection, now: i64) -> Result<Self> {
        let restart_ids = db
            .prepare("SELECT id FROM ups_events WHERE ended_ms IS NULL")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Self {
            last_success_ms: now,
            restart_ids,
            test_result: db
                .query_row(
                    "SELECT test_result FROM ups_samples ORDER BY ts_ms DESC LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .optional()?
                .flatten(),
        })
    }
    /// State changes only after commit; callers can retry failed writes safely.
    pub fn record(
        &mut self,
        db: &mut Connection,
        sample: Option<&UpsCurrent>,
        now: i64,
    ) -> Result<Vec<UpsEvent>> {
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut changed = Vec::new();
        let mut open = tx.prepare("SELECT id,kind,started_ms,ended_ms,min_charge_percent,min_runtime_s,detail,end_reason FROM ups_events WHERE ended_ms IS NULL")?.query_map([], event)?.collect::<rusqlite::Result<Vec<_>>>()?;
        let at = sample.map_or(now, |s| s.ts_ms);
        if let Some(s) = sample {
            let previous: Option<i64> = tx
                .query_row(
                    "SELECT ts_ms FROM ups_samples ORDER BY ts_ms DESC LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .optional()?;
            ensure!(
                previous.is_none_or(|p| s.ts_ms > p),
                "UPS sample timestamp did not advance"
            );
            let elapsed = previous.map_or(0, |p| s.ts_ms - p);
            let coverage = if (1..=30_000).contains(&elapsed) {
                elapsed
            } else {
                0
            };
            let energy = sample_energy(s.load_w, coverage)?;
            tx.execute(
                "INSERT INTO ups_samples VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                params![
                    s.ts_ms,
                    s.status,
                    s.charge_percent,
                    s.runtime_s,
                    s.load_w,
                    s.input_v,
                    s.output_v,
                    s.battery_v,
                    s.test_result.as_ref().or(self.test_result.as_ref()),
                    energy,
                    coverage
                ],
            )?;
            // At 10s cadence this re-aggregates at most 360 readings. Keeping SQL
            // AVG avoids biased averages when optional NUT values disappear.
            let hour = s.ts_ms / HOUR_MS * HOUR_MS;
            tx.execute(ROLLUP_SQL, params![hour, hour + HOUR_MS])?;
            for e in &mut open {
                e.min_charge_percent = match (e.min_charge_percent, s.charge_percent) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (a, b) => a.or(b),
                };
                e.min_runtime_s = match (e.min_runtime_s, s.runtime_s) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (a, b) => a.or(b),
                };
                let restart = self.restart_ids.contains(&e.id);
                let recovered = match e.kind.as_str() {
                    "on_battery" => s.on_line == Some(true) && s.on_battery != Some(true),
                    "low_battery" => s.low_battery == Some(false),
                    "replace_battery" => s.replace_battery == Some(false),
                    "comms_lost" => true,
                    _ => false,
                };
                if restart || recovered {
                    e.ended_ms = Some(at);
                    e.end_reason = Some(if restart { "restart" } else { "recovered" }.into());
                }
                tx.execute("UPDATE ups_events SET ended_ms=?2,min_charge_percent=?3,min_runtime_s=?4,end_reason=?5 WHERE id=?1", params![e.id,e.ended_ms,e.min_charge_percent,e.min_runtime_s,e.end_reason])?;
                if e.ended_ms.is_some() {
                    changed.push(e.clone());
                }
            }
        }
        let mut kinds = Vec::new();
        if let Some(s) = sample {
            for (kind, active) in [
                ("on_battery", s.on_battery),
                ("low_battery", s.low_battery),
                ("replace_battery", s.replace_battery),
            ] {
                if active == Some(true) {
                    kinds.push((kind, None));
                }
            }
            if let Some(result) = &s.test_result {
                // First observation is a baseline, not an invented test run.
                if self.test_result.as_ref().is_some_and(|old| old != result) {
                    kinds.push(("self_test", Some(result.clone())));
                }
            }
        } else if now.saturating_sub(self.last_success_ms) >= 30_000 {
            kinds.push(("comms_lost", None));
        }
        for (kind, detail) in kinds {
            if open.iter().any(|e| e.kind == kind && e.ended_ms.is_none()) {
                continue;
            }
            let instant = kind == "self_test";
            let mut e = UpsEvent {
                id: 0,
                kind: kind.into(),
                started_ms: at,
                ended_ms: instant.then_some(at),
                min_charge_percent: sample.and_then(|s| s.charge_percent),
                min_runtime_s: sample.and_then(|s| s.runtime_s),
                detail,
                end_reason: instant.then(|| "recovered".into()),
            };
            tx.execute("INSERT INTO ups_events(kind,started_ms,ended_ms,min_charge_percent,min_runtime_s,detail,end_reason) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![e.kind,e.started_ms,e.ended_ms,e.min_charge_percent,e.min_runtime_s,e.detail,e.end_reason])?;
            e.id = tx.last_insert_rowid();
            if instant {
                let mut opened = e.clone();
                opened.ended_ms = None;
                opened.end_reason = None;
                changed.push(opened);
            }
            changed.push(e);
        }
        tx.commit()?;
        if let Some(s) = sample {
            self.last_success_ms = s.ts_ms;
            self.restart_ids.clear();
            if s.test_result.is_some() {
                self.test_result.clone_from(&s.test_result);
            }
        }
        Ok(changed)
    }
}

const ROLLUP_SQL: &str = "INSERT OR REPLACE INTO ups_rollup_hourly
SELECT ?1,COUNT(*),MIN(charge_percent),AVG(charge_percent),MAX(charge_percent),
MIN(load_w),AVG(load_w),MAX(load_w),MIN(input_v),AVG(input_v),MAX(input_v),
MIN(runtime_s),SUM(energy_mwh),SUM(coverage_ms),SUM(CASE WHEN instr(' '||status||' ',' OB ')>0 THEN coverage_ms ELSE 0 END)/1000.0
FROM ups_samples WHERE ts_ms>=?1 AND ts_ms<?2";

/// Separate transaction sees only committed rollups of completed hours.
/// Work is capped at 1000 raw rows per five-minute maintenance tick.
pub fn retain(db: &mut Connection, now: i64) -> Result<usize> {
    let cutoff = (now - 7 * DAY_MS).max(0);
    let tx = db.transaction()?;
    let count = tx.execute("DELETE FROM ups_samples WHERE ts_ms IN (SELECT ts_ms FROM ups_samples WHERE ts_ms<?1 ORDER BY ts_ms LIMIT 1000) AND EXISTS(SELECT 1 FROM ups_rollup_hourly r WHERE r.ts_ms=ups_samples.ts_ms/3600000*3600000)", [cutoff])?;
    tx.commit()?;
    Ok(count)
}

#[derive(Debug, Serialize, ToSchema)]
pub struct UpsMetric {
    pub min: Option<f64>,
    pub avg: Option<f64>,
    pub max: Option<f64>,
}
#[derive(Debug, Serialize, ToSchema)]
pub struct UpsPoint {
    pub ts_ms: i64,
    pub sample_count: i64,
    pub charge_percent: UpsMetric,
    pub load_w: UpsMetric,
    pub input_v: UpsMetric,
    pub runtime_s: Option<i64>,
}
pub const RAW_HISTORY_SQL: &str = "SELECT MIN(ts_ms),COUNT(*),MIN(charge_percent),AVG(charge_percent),MAX(charge_percent),MIN(load_w),AVG(load_w),MAX(load_w),MIN(input_v),AVG(input_v),MAX(input_v),MIN(runtime_s) FROM ups_samples WHERE ts_ms>=?1 AND ts_ms<=?2 GROUP BY (ts_ms-?1)/?3 ORDER BY (ts_ms-?1)/?3";
pub const HOURLY_HISTORY_SQL: &str = "SELECT ts_ms,sample_count,charge_min,charge_avg,charge_max,load_min,load_avg,load_max,input_min,input_avg,input_max,runtime_min_s FROM ups_rollup_hourly WHERE ts_ms>=?1 AND ts_ms<=?2 ORDER BY ts_ms";
pub fn history(db: &Connection, since: i64, now: i64, raw: bool) -> Result<Vec<UpsPoint>> {
    let mut statement = db.prepare(if raw {
        RAW_HISTORY_SQL
    } else {
        HOURLY_HISTORY_SQL
    })?;
    let width = (now - since + 1 + 719) / 720;
    let parameters = if raw {
        vec![since, now, width]
    } else {
        vec![since / HOUR_MS * HOUR_MS, now]
    };
    Ok(statement
        .query_map(rusqlite::params_from_iter(parameters), |r| {
            let metric = |i| -> rusqlite::Result<UpsMetric> {
                Ok(UpsMetric {
                    min: r.get(i)?,
                    avg: r.get(i + 1)?,
                    max: r.get(i + 2)?,
                })
            };
            Ok(UpsPoint {
                ts_ms: r.get(0)?,
                sample_count: r.get(1)?,
                charge_percent: metric(2)?,
                load_w: metric(5)?,
                input_v: metric(8)?,
                runtime_s: r.get(11)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

#[derive(Debug, Serialize, ToSchema)]
pub struct UpsEnergy {
    pub energy_mwh: i64,
    pub cost_nano_usd: Option<i64>,
    pub gpu_energy_mwh: Option<i64>,
    pub electricity_rate_micro_usd_per_kwh: Option<i64>,
    pub coverage_percent: f64,
}
/// Internal read result; intervals are not part of the API response.
pub struct CoveredEnergy {
    pub energy: UpsEnergy,
    pub intervals: Option<Vec<(i64, i64)>>,
}
pub const ENERGY_SQL: &str = "SELECT energy_mwh,coverage_ms,NULL,0 FROM ups_rollup_hourly WHERE ts_ms>=?1 AND ts_ms<=?2 UNION ALL SELECT energy_mwh,coverage_ms,ts_ms,coverage_ms FROM ups_samples WHERE ts_ms>=?3 AND ts_ms<?1 UNION ALL SELECT 0,0,ts_ms,coverage_ms FROM ups_samples WHERE ts_ms>=?1 AND ts_ms<=?2 AND coverage_ms>0 AND EXISTS(SELECT 1 FROM ups_rollup_hourly WHERE ts_ms=ups_samples.ts_ms/3600000*3600000)";
pub fn energy(db: &Connection, since: i64, now: i64) -> Result<CoveredEnergy> {
    let rate = settings(db)?.electricity_rate_micro_usd_per_kwh;
    let first_hour = (since + HOUR_MS - 1) / HOUR_MS * HOUR_MS;
    // Full buckets plus the retained leading partial hour. Beyond raw retention,
    // omit that partial hour rather than inventing energy; coverage exposes it.
    // Return raw intervals alongside the same energy buckets, in one statement.
    // A retained rollup without its raw intervals cannot establish GPU coverage.
    let mut statement = db.prepare(ENERGY_SQL)?;
    let mut rows = statement.query(params![first_hour, now, since])?;
    let (mut energy, mut coverage) = (0i64, 0i64);
    let mut intervals = Vec::new();
    let mut raw_coverage = 0i64;
    while let Some(row) = rows.next()? {
        energy = energy
            .checked_add(row.get(0)?)
            .ok_or_else(|| anyhow::anyhow!("energy sum overflow"))?;
        coverage = coverage
            .checked_add(row.get(1)?)
            .ok_or_else(|| anyhow::anyhow!("coverage sum overflow"))?;
        let elapsed: i64 = row.get(3)?;
        if elapsed > 0 {
            let end: i64 = row.get(2)?;
            intervals.push((end - elapsed, end));
            raw_coverage = raw_coverage
                .checked_add(elapsed)
                .ok_or_else(|| anyhow::anyhow!("coverage sum overflow"))?;
        }
    }
    intervals.sort_unstable();
    Ok(CoveredEnergy {
        energy: UpsEnergy {
            energy_mwh: energy,
            cost_nano_usd: rate.map(|r| cost(energy, r)).transpose()?,
            gpu_energy_mwh: None,
            electricity_rate_micro_usd_per_kwh: rate,
            coverage_percent: (100.0 * coverage as f64 / (now - since) as f64).min(100.0),
        },
        intervals: (raw_coverage == coverage).then_some(intervals),
    })
}

/// Integrate GPU 0 only over stored UPS intervals. Require samples within 30s
/// of both edges and reject gaps inside an interval. Round each UPS interval
/// once, using its right-endpoint GPU reading just like the UPS load reading.
pub fn gpu_energy(samples: &[shared::GpuSample], intervals: &[(i64, i64)]) -> Result<Option<i64>> {
    let mut points: Vec<_> = samples.iter().filter(|s| s.index == 0).collect();
    points.sort_by_key(|s| s.ts);
    let mut total = 0i64;
    for &(start, end) in intervals {
        // Latest reading at each endpoint; if no recent one precedes it, the
        // first following reading is usable within the same 30s tolerance.
        let at = |ts| {
            let i = points.partition_point(|s| s.ts <= ts);
            let point = if i > 0 && ts - points[i - 1].ts <= 30_000 {
                points[i - 1]
            } else {
                *points.get(i)?
            };
            ((point.ts - ts).abs() <= 30_000).then_some(point)
        };
        let (Some(_), Some(right)) = (at(start), at(end)) else {
            return Ok(None);
        };
        // Include the readings bracketing the interval, not just readings
        // inside it: a hole can span the entire covered UPS interval.
        let first = points.partition_point(|s| s.ts <= start).saturating_sub(1);
        let last = (points.partition_point(|s| s.ts < end) + 1).min(points.len());
        for pair in points[first..last].windows(2) {
            if pair[0].ts < end && pair[1].ts > start && pair[1].ts - pair[0].ts > 30_000 {
                return Ok(None);
            }
        }
        total = total
            .checked_add(sample_energy(Some(right.power_w), end - start)?)
            .ok_or_else(|| anyhow::anyhow!("GPU energy sum overflow"))?;
    }
    Ok(Some(total))
}
