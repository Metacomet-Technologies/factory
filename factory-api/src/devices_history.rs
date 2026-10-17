//! Device sample storage. A raw row and its hourly rollup commit together.
use crate::devices::DeviceView;
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use utoipa::ToSchema;

pub const HOUR_MS: i64 = 3_600_000;
pub const DAY_MS: i64 = 24 * HOUR_MS;
const RETAIN_BATCH: i64 = 1000;

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
pub struct DeviceMetric {
    pub min: Option<f64>,
    pub avg: Option<f64>,
    pub max: Option<f64>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DeviceHistory {
    pub device_id: String,
    pub range: String,
    pub generated_at_ms: i64,
    pub points: Vec<DevicePoint>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DevicePoint {
    pub ts_ms: i64,
    pub sample_count: i64,
    pub cpu_percent: DeviceMetric,
    pub memory_used_bytes: DeviceMetric,
    pub load1: DeviceMetric,
    pub disk_read_bps: DeviceMetric,
    pub disk_write_bps: DeviceMetric,
    pub net_rx_bps: DeviceMetric,
    pub net_tx_bps: DeviceMetric,
    pub cpu_temp_c: DeviceMetric,
}

pub struct StoredSample {
    pub device_id: String,
    pub ts_ms: i64,
    pub cpu_percent: Option<f64>,
    pub memory_used_bytes: Option<i64>,
    pub load1: Option<f64>,
    pub disk_read_bps: Option<f64>,
    pub disk_write_bps: Option<f64>,
    pub net_rx_bps: Option<f64>,
    pub net_tx_bps: Option<f64>,
    pub cpu_temp_c: Option<f64>,
}

fn finite(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite())
}

impl StoredSample {
    pub fn from_view(view: &DeviceView) -> Self {
        let device = &view.device;
        let bytes = device
            .memory
            .used
            .value
            .filter(|v| v.is_finite() && *v >= 0.0 && *v < i64::MAX as f64);
        Self {
            device_id: device.device_id.clone(),
            ts_ms: device.observed_at_ms,
            cpu_percent: finite(device.cpu.utilization.value),
            memory_used_bytes: bytes.map(|v| v as i64),
            load1: finite(device.cpu.load1.value),
            disk_read_bps: finite(device.disk_io.read.value),
            disk_write_bps: finite(device.disk_io.write.value),
            net_rx_bps: finite(device.network.rx.value),
            net_tx_bps: finite(device.network.tx.value),
            cpu_temp_c: finite(device.cpu.temperature.value),
        }
    }
}

const INSERT_SQL: &str = "INSERT INTO device_samples VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)";
const ROLLUP_SQL: &str = "INSERT OR REPLACE INTO device_rollup_hourly
SELECT ?2,?1,COUNT(*),
MIN(cpu_percent),AVG(cpu_percent),MAX(cpu_percent),
MIN(memory_used_bytes),AVG(memory_used_bytes),MAX(memory_used_bytes),
MIN(load1),AVG(load1),MAX(load1),
MIN(disk_read_bps),AVG(disk_read_bps),MAX(disk_read_bps),
MIN(disk_write_bps),AVG(disk_write_bps),MAX(disk_write_bps),
MIN(net_rx_bps),AVG(net_rx_bps),MAX(net_rx_bps),
MIN(net_tx_bps),AVG(net_tx_bps),MAX(net_tx_bps),
MIN(cpu_temp_c),AVG(cpu_temp_c),MAX(cpu_temp_c)
FROM device_samples WHERE device_id=?2 AND ts_ms>=?1 AND ts_ms<?3";

/// Skip a timestamp that does not advance. A retried write finds the row already committed.
pub fn record(db: &mut Connection, sample: &StoredSample) -> Result<()> {
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let previous: Option<i64> = tx
        .query_row(
            "SELECT ts_ms FROM device_samples WHERE device_id=?1 ORDER BY ts_ms DESC LIMIT 1",
            [&sample.device_id],
            |row| row.get(0),
        )
        .optional()?;
    if previous.is_some_and(|ts| sample.ts_ms <= ts) {
        tx.commit()?;
        return Ok(());
    }
    tx.execute(
        INSERT_SQL,
        params![
            sample.device_id,
            sample.ts_ms,
            sample.cpu_percent,
            sample.memory_used_bytes,
            sample.load1,
            sample.disk_read_bps,
            sample.disk_write_bps,
            sample.net_rx_bps,
            sample.net_tx_bps,
            sample.cpu_temp_c
        ],
    )?;
    let hour = sample.ts_ms / HOUR_MS * HOUR_MS;
    tx.execute(ROLLUP_SQL, params![hour, sample.device_id, hour + HOUR_MS])?;
    tx.commit()?;
    Ok(())
}

/// Completed hours only. A raw row whose rollup is missing stays until that rollup commits.
pub fn retain(db: &mut Connection, now: i64) -> Result<usize> {
    let cutoff = (now - 7 * DAY_MS).max(0);
    let tx = db.transaction()?;
    let count = tx.execute(
        "DELETE FROM device_samples WHERE (device_id, ts_ms) IN (SELECT device_id, ts_ms FROM device_samples WHERE ts_ms<?1 ORDER BY ts_ms LIMIT ?2) AND EXISTS(SELECT 1 FROM device_rollup_hourly r WHERE r.device_id=device_samples.device_id AND r.ts_ms=device_samples.ts_ms/3600000*3600000)",
        params![cutoff, RETAIN_BATCH],
    )?;
    tx.commit()?;
    Ok(count)
}

pub const RAW_HISTORY_SQL: &str = "SELECT MIN(ts_ms),COUNT(*),MIN(cpu_percent),AVG(cpu_percent),MAX(cpu_percent),MIN(memory_used_bytes),AVG(memory_used_bytes),MAX(memory_used_bytes),MIN(load1),AVG(load1),MAX(load1),MIN(disk_read_bps),AVG(disk_read_bps),MAX(disk_read_bps),MIN(disk_write_bps),AVG(disk_write_bps),MAX(disk_write_bps),MIN(net_rx_bps),AVG(net_rx_bps),MAX(net_rx_bps),MIN(net_tx_bps),AVG(net_tx_bps),MAX(net_tx_bps),MIN(cpu_temp_c),AVG(cpu_temp_c),MAX(cpu_temp_c) FROM device_samples INDEXED BY sqlite_autoindex_device_samples_1 WHERE device_id=?1 AND ts_ms>=?2 AND ts_ms<=?3 GROUP BY (ts_ms-?2)/?4 ORDER BY (ts_ms-?2)/?4";
pub const HOURLY_HISTORY_SQL: &str = "SELECT ts_ms,sample_count,cpu_min,cpu_avg,cpu_max,mem_min,mem_avg,mem_max,load_min,load_avg,load_max,read_min,read_avg,read_max,write_min,write_avg,write_max,rx_min,rx_avg,rx_max,tx_min,tx_avg,tx_max,temp_min,temp_avg,temp_max FROM device_rollup_hourly INDEXED BY sqlite_autoindex_device_rollup_hourly_1 WHERE device_id=?1 AND ts_ms>=?2 AND ts_ms<=?3 ORDER BY ts_ms LIMIT 720";

pub fn history(
    db: &Connection,
    device_id: &str,
    since: i64,
    now: i64,
    raw: bool,
) -> Result<Vec<DevicePoint>> {
    let mut statement = db.prepare(if raw {
        RAW_HISTORY_SQL
    } else {
        HOURLY_HISTORY_SQL
    })?;
    let width = (now - since + 1 + 719) / 720;
    let parameters: Vec<rusqlite::types::Value> = if raw {
        vec![
            device_id.to_string().into(),
            since.into(),
            now.into(),
            width.into(),
        ]
    } else {
        vec![
            device_id.to_string().into(),
            (since / HOUR_MS * HOUR_MS).into(),
            now.into(),
        ]
    };
    Ok(statement
        .query_map(rusqlite::params_from_iter(parameters), |row| {
            let metric = |index| -> rusqlite::Result<DeviceMetric> {
                Ok(DeviceMetric {
                    min: row.get(index)?,
                    avg: row.get(index + 1)?,
                    max: row.get(index + 2)?,
                })
            };
            Ok(DevicePoint {
                ts_ms: row.get(0)?,
                sample_count: row.get(1)?,
                cpu_percent: metric(2)?,
                memory_used_bytes: metric(5)?,
                load1: metric(8)?,
                disk_read_bps: metric(11)?,
                disk_write_bps: metric(14)?,
                net_rx_bps: metric(17)?,
                net_tx_bps: metric(20)?,
                cpu_temp_c: metric(23)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn record_view(db: &mut Connection, view: &DeviceView) -> Result<()> {
    record(db, &StoredSample::from_view(view))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data;
    use factory_db::explain::{self, Exception, ExceptionKind, RequiredSearch};

    fn db() -> Connection {
        let mut db = Connection::open_in_memory().unwrap();
        data::initialize(&mut db).unwrap();
        db
    }

    fn sample(ts: i64, cpu: Option<f64>) -> StoredSample {
        StoredSample {
            device_id: "factory-gpu".into(),
            ts_ms: ts,
            cpu_percent: cpu,
            memory_used_bytes: cpu.map(|_| 100),
            load1: Some(0.5),
            disk_read_bps: None,
            disk_write_bps: None,
            net_rx_bps: None,
            net_tx_bps: None,
            cpu_temp_c: None,
        }
    }

    #[test]
    fn migration_from_version_1_applies_device_tables() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("ups_schema.sql")).unwrap();
        db.pragma_update(None, "user_version", 1).unwrap();
        db.execute("INSERT INTO requests VALUES(7, 10, '{}')", [])
            .unwrap();
        data::initialize(&mut db).unwrap();
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert_eq!(
            db.query_row("SELECT id FROM requests", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            7
        );
        assert!(db.execute("INSERT INTO device_samples(device_id, ts_ms, cpu_percent) VALUES('factory-gpu', 1, 101)", []).is_err());
        assert!(db.execute("INSERT INTO device_samples(device_id, ts_ms, memory_used_bytes) VALUES('factory-gpu', 1, -1)", []).is_err());
    }

    #[test]
    fn nulls_gaps_retention_and_bounds() {
        let mut db = db();
        record(&mut db, &sample(1_000, None)).unwrap();
        record(&mut db, &sample(1_000, Some(1.0))).unwrap();
        record(&mut db, &sample(HOUR_MS + 1_000, Some(50.0))).unwrap();
        record(&mut db, &sample(3 * HOUR_MS + 1_000, Some(100.0))).unwrap();
        let points = history(&db, "factory-gpu", 0, 4 * HOUR_MS, false).unwrap();
        assert_eq!(points.len(), 3);
        assert!(
            points
                .iter()
                .all(|point| point.cpu_percent.min.is_some() || point.ts_ms == 0)
        );
        assert_eq!(points[0].cpu_percent.avg, None);
        assert_eq!(points[1].cpu_percent.avg, Some(50.0));
        assert!(points.iter().all(|point| point.disk_read_bps.avg.is_none()));
        assert_eq!(
            history(&db, "factory-gpu", 0, 4 * HOUR_MS, false)
                .unwrap()
                .len(),
            3
        );

        assert_eq!(retain(&mut db, 4 * HOUR_MS).unwrap(), 0);
        db.execute("DELETE FROM device_rollup_hourly WHERE ts_ms=0", [])
            .unwrap();
        let old = 7 * DAY_MS + 4 * HOUR_MS;
        assert_eq!(retain(&mut db, old).unwrap(), 2);
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM device_samples WHERE ts_ms<3600000",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        record(&mut db, &sample(2_000, Some(10.0))).unwrap();
        assert_eq!(retain(&mut db, old).unwrap(), 2);
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM device_samples WHERE ts_ms<3600000",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );

        let base = 10 * HOUR_MS;
        db.execute(
            "WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1499) INSERT INTO device_samples(device_id, ts_ms) SELECT 'factory-gpu', ?1 + x FROM n",
            [base],
        )
        .unwrap();
        db.execute(
            "INSERT INTO device_rollup_hourly(device_id, ts_ms, sample_count) VALUES('factory-gpu', ?1, 1)",
            [base],
        )
        .unwrap();
        let now = base + 7 * DAY_MS + 2_000;
        assert_eq!(retain(&mut db, now).unwrap(), 1000);
        assert_eq!(retain(&mut db, now).unwrap(), 500);
        assert_eq!(retain(&mut db, now).unwrap(), 0);
    }

    #[test]
    fn history_query_plans_use_indexes_and_cap_points() {
        let db = db();
        db.execute_batch("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<8000) INSERT INTO device_samples(device_id, ts_ms, cpu_percent) SELECT 'factory-gpu', x*10000, x%17 FROM n; INSERT INTO device_rollup_hourly(device_id, ts_ms, sample_count, cpu_min, cpu_avg, cpu_max) SELECT 'factory-gpu', ts_ms, 1, cpu_percent, cpu_percent, cpu_percent FROM device_samples WHERE ts_ms%3600000=0; ANALYZE;").unwrap();
        let raw = history(&db, "factory-gpu", 0, DAY_MS, true).unwrap();
        assert!(raw.len() <= 720);
        assert!(raw.iter().map(|point| point.sample_count).sum::<i64>() > 0);
        let hourly = history(&db, "factory-gpu", 0, 8 * DAY_MS, false).unwrap();
        assert!(hourly.len() <= 720);
        let cases: Vec<(&str, Vec<rusqlite::types::Value>, &str, bool)> = vec![
            (
                RAW_HISTORY_SQL,
                vec![
                    "factory-gpu".to_string().into(),
                    0_i64.into(),
                    DAY_MS.into(),
                    5_001_i64.into(),
                ],
                "device_samples",
                true,
            ),
            (
                HOURLY_HISTORY_SQL,
                vec![
                    "factory-gpu".to_string().into(),
                    0_i64.into(),
                    (8 * DAY_MS).into(),
                ],
                "device_rollup_hourly",
                false,
            ),
        ];
        for (sql, args, table, grouped) in cases {
            let plan = explain::query_plan(&db, sql, rusqlite::params_from_iter(args)).unwrap();
            let exceptions = if grouped {
                vec![Exception {
                    kind: ExceptionKind::ReviewedLegacySort,
                    table: "",
                    reason: "range-bounded samples group into at most 720 time buckets; dynamic range buckets cannot use a persistent index",
                }]
            } else {
                vec![]
            };
            explain::validate(&plan, &[RequiredSearch { table, index: None }], &exceptions)
                .unwrap();
        }
    }
}
