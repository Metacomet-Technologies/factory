use anyhow::Result;
use factory_api::{
    data,
    network::{Burst, DEVICE_ID, Layer, Rtt, Sample},
    network_history::*,
    ups_history::{DAY_MS, HOUR_MS},
};
use factory_db::{
    Category, Scope, Tracked,
    explain::{self, Exception, ExceptionKind, RequiredSearch},
    migrations::{Migration, run, schema_fingerprint},
};
use rusqlite::Connection;
use serde_json::{Value, json};

const TABLES: [&str; 4] = [
    "net_probe_samples",
    "net_probe_rollup_hourly",
    "net_speed_tests",
    "net_events",
];

fn database() -> Result<Connection> {
    let mut db = Connection::open_in_memory()?;
    data::initialize(&mut db)?;
    Ok(db)
}
fn version(db: &Connection) -> Result<i64> {
    Ok(db.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

#[test]
fn version_one_database_upgrades_to_three_and_reruns_are_noops() -> Result<()> {
    let mut db = Connection::open_in_memory()?;
    run(
        &mut db,
        &[Migration {
            version: 1,
            sql: include_str!("../src/ups_schema.sql"),
            checksum: 0xf7820cc3e88268c1,
        }],
        None,
        |_, _| Ok(()),
        |_, _| Ok(()),
    )?;
    db.execute(
        "INSERT INTO ups_samples(ts_ms,energy_mwh,coverage_ms) VALUES(5,7,0)",
        [],
    )?;
    assert_eq!(version(&db)?, 1);
    data::initialize(&mut db)?;
    assert_eq!(version(&db)?, 3);
    let upgraded = schema_fingerprint(&db)?;
    data::initialize(&mut db)?;
    assert_eq!(version(&db)?, 3);
    assert_eq!(schema_fingerprint(&db)?, upgraded);
    assert_eq!(
        db.query_row(
            "SELECT energy_mwh FROM ups_samples WHERE ts_ms=5",
            [],
            |r| r.get::<_, i64>(0)
        )?,
        7
    );
    // An empty database reaches the identical schema.
    assert_eq!(schema_fingerprint(&database()?)?, upgraded);
    Ok(())
}

#[test]
fn network_tables_are_strict_and_reject_invalid_rows() -> Result<()> {
    let db = database()?;
    for table in TABLES {
        assert_eq!(
            db.query_row(
                "SELECT strict FROM pragma_table_list WHERE name=?1",
                [table],
                |r| r.get::<_, i64>(0)
            )?,
            1,
            "{table}"
        );
    }
    const SAMPLE: &str = "INSERT INTO net_probe_samples(device_id,ts_ms,target,layer,address,sent,received,rtt_min_us,rtt_avg_us,rtt_max_us,rtt_mdev_us) VALUES";
    const ROLLUP: &str = "INSERT INTO net_probe_rollup_hourly(device_id,ts_ms,target,layer,sample_count,sent,received,rtt_min_us,rtt_avg_us,rtt_max_us,rtt_mdev_p95_us) VALUES";
    const SPEED: &str = "INSERT INTO net_speed_tests(device_id,started_ms,ended_ms,outcome,error,download_bps,upload_bps,download_bytes,upload_bytes) VALUES";
    const EVENT: &str = "INSERT INTO net_events(device_id,state,layer,reason,started_ms,ended_ms,end_reason,peak_loss_percent) VALUES";
    for values in [
        "('factory-gpu',30000,'gateway','lan','192.168.4.1',10,10,300,400,900,100)",
        "('factory-gpu',30000,'1.1.1.1','wan','1.1.1.1',10,0,NULL,NULL,NULL,NULL)",
        "('factory-gpu',30000,'gateway2','lan',NULL,10,0,NULL,NULL,NULL,NULL)",
    ] {
        db.execute(&format!("{SAMPLE}{values}"), [])?;
    }
    db.execute(
        &format!("{ROLLUP}('factory-gpu',3600000,'gateway','lan',2,20,15,1,2,3,4)"),
        [],
    )?;
    db.execute(
        &format!("{SPEED}('factory-gpu',1,2,'ok',NULL,900000000,800000000,1,1)"),
        [],
    )?;
    db.execute(
        &format!("{SPEED}('factory-gpu',1,2,'failed','HTTP 429',NULL,NULL,0,0)"),
        [],
    )?;
    db.execute(
        &format!("{SPEED}('factory-gpu',1,2,'timeout',NULL,NULL,NULL,5,0)"),
        [],
    )?;
    db.execute(
        &format!("{EVENT}('factory-gpu','down','wan',NULL,1,2,'recovered',100.0)"),
        [],
    )?;
    db.execute(
        &format!("{EVENT}('factory-gpu','degraded','dns','latency',3,NULL,NULL,0.0)"),
        [],
    )?;
    for invalid in [
        format!("{SAMPLE}('',1,'gateway','lan',NULL,10,0,NULL,NULL,NULL,NULL)"),
        format!("{SAMPLE}('factory-gpu',-1,'gateway','lan',NULL,10,0,NULL,NULL,NULL,NULL)"),
        format!("{SAMPLE}('factory-gpu',1,'','lan',NULL,10,0,NULL,NULL,NULL,NULL)"),
        format!("{SAMPLE}('factory-gpu',1,'x','wifi',NULL,10,0,NULL,NULL,NULL,NULL)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan','',10,0,NULL,NULL,NULL,NULL)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan',NULL,0,0,NULL,NULL,NULL,NULL)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan',NULL,101,0,NULL,NULL,NULL,NULL)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan',NULL,10,11,1,1,1,0)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan',NULL,10,0,1,1,1,0)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan',NULL,10,5,NULL,NULL,NULL,NULL)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan',NULL,10,5,1,1,1,NULL)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan',NULL,10,5,-1,1,1,0)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan',NULL,10,5,5,4,6,0)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan',NULL,10,5,1,4,3,0)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan',NULL,10,5,1,2,3,-1)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan',NULL,10,5,1.5,2,3,0)"),
        format!("{SAMPLE}('factory-gpu',30000,'gateway','lan',NULL,10,0,NULL,NULL,NULL,NULL)"),
        format!("{ROLLUP}('factory-gpu',1,'x','lan',1,10,10,1,1,1,0)"),
        format!("{ROLLUP}('factory-gpu',0,'x','lan',0,10,10,1,1,1,0)"),
        format!("{ROLLUP}('factory-gpu',0,'x','lan',2,1,1,1,1,1,0)"),
        format!("{ROLLUP}('factory-gpu',0,'x','lan',1,10,11,1,1,1,0)"),
        format!("{ROLLUP}('factory-gpu',0,'x','lan',1,10,0,1,1,1,0)"),
        format!("{ROLLUP}('factory-gpu',0,'x','lan',1,10,1,NULL,NULL,NULL,NULL)"),
        format!("{ROLLUP}('factory-gpu',0,'x','tailscale',1,10,1,1,1,1,0)"),
        format!("{SPEED}('factory-gpu',2,1,'ok',NULL,1,1,0,0)"),
        format!("{SPEED}('factory-gpu',1,2,'partial',NULL,1,1,0,0)"),
        format!("{SPEED}('factory-gpu',1,2,'failed',NULL,NULL,NULL,0,0)"),
        format!("{SPEED}('factory-gpu',1,2,'ok',NULL,1,NULL,0,0)"),
        format!("{SPEED}('factory-gpu',1,2,'failed','boom',1,NULL,0,0)"),
        format!("{SPEED}('factory-gpu',1,2,'ok',NULL,-1,1,0,0)"),
        format!("{SPEED}('factory-gpu',1,2,'ok',NULL,1,1,-1,0)"),
        format!("{SPEED}('factory-gpu',1,2,'ok',NULL,1.5,1,0,0)"),
        format!("{EVENT}('factory-gpu','down','wan','loss',1,NULL,NULL,1.0)"),
        format!("{EVENT}('factory-gpu','degraded','wan',NULL,1,NULL,NULL,1.0)"),
        format!("{EVENT}('factory-gpu','degraded','wan','speed',1,NULL,NULL,1.0)"),
        format!("{EVENT}('factory-gpu','up','wan',NULL,1,NULL,NULL,1.0)"),
        format!("{EVENT}('factory-gpu','down','wan',NULL,2,1,'recovered',1.0)"),
        format!("{EVENT}('factory-gpu','down','wan',NULL,1,2,NULL,1.0)"),
        format!("{EVENT}('factory-gpu','down','wan',NULL,1,NULL,'recovered',1.0)"),
        format!("{EVENT}('factory-gpu','down','wan',NULL,1,2,'resolved',1.0)"),
        format!("{EVENT}('factory-gpu','down','wan',NULL,1,2,'recovered',100.5)"),
        // One open episode per device.
        format!("{EVENT}('factory-gpu','down','lan',NULL,4,NULL,NULL,100.0)"),
    ] {
        assert!(db.execute(&invalid, []).is_err(), "{invalid}");
    }
    db.execute(
        &format!("{EVENT}('factory-console','down','lan',NULL,4,NULL,NULL,100.0)"),
        [],
    )?;
    Ok(())
}

fn sample(ts_ms: i64, target: &str, received: u32, rtt: Option<(i64, i64, i64, i64)>) -> Sample {
    let layer = match target {
        "gateway" => Layer::Lan,
        "dns" => Layer::Dns,
        "tailnet" => Layer::Tailnet,
        _ => Layer::Wan,
    };
    Sample {
        ts_ms,
        layer,
        target: target.into(),
        address: Some(
            if layer == Layer::Lan {
                "192.168.4.1"
            } else {
                target
            }
            .into(),
        ),
        burst: Burst {
            sent: 10,
            received,
            rtt: rtt.map(|(min_us, avg_us, max_us, mdev_us)| Rtt {
                min_us,
                avg_us,
                max_us,
                mdev_us,
            }),
        },
    }
}
fn tick(ts_ms: i64) -> Vec<Sample> {
    ["gateway", "1.1.1.1", "8.8.8.8", "dns", "tailnet"]
        .into_iter()
        .map(|target| sample(ts_ms, target, 10, Some((400, 500, 900, 100))))
        .collect()
}
fn count(db: &Connection, table: &str) -> Result<i64> {
    Ok(db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?)
}

#[test]
fn hourly_rollup_weights_latency_by_replies_and_takes_p95_jitter() -> Result<()> {
    assert_eq!(
        rollup(&[]),
        HourRollup {
            sample_count: 0,
            sent: 0,
            received: 0,
            rtt_min_us: None,
            rtt_avg_us: None,
            rtt_max_us: None,
            rtt_mdev_p95_us: None,
        }
    );
    // Nearest rank: ceil(0.95 * 20) = 19th of 1..=20, ceil(0.95 * 21) = 20th of 1..=21.
    let bursts = |n: i64| -> Vec<Burst> {
        (1..=n)
            .map(|mdev_us| sample(0, "gateway", 10, Some((1, 1, 1, mdev_us))).burst)
            .collect()
    };
    assert_eq!(rollup(&bursts(20)).rtt_mdev_p95_us, Some(19));
    assert_eq!(rollup(&bursts(21)).rtt_mdev_p95_us, Some(20));
    assert_eq!(rollup(&bursts(1)).rtt_mdev_p95_us, Some(1));
    let mut db = database()?;
    let hour = 10 * HOUR_MS;
    record(
        &mut db,
        DEVICE_ID,
        &[sample(hour, "gateway", 10, Some((100, 200, 300, 10)))],
    )?;
    record(
        &mut db,
        DEVICE_ID,
        &[sample(
            hour + 30_000,
            "gateway",
            5,
            Some((50, 400, 900, 30)),
        )],
    )?;
    record(
        &mut db,
        DEVICE_ID,
        &[sample(hour + 60_000, "gateway", 0, None)],
    )?;
    record(
        &mut db,
        DEVICE_ID,
        &[sample(hour + HOUR_MS, "gateway", 10, Some((7, 8, 9, 1)))],
    )?;
    let hourly = serde_json::to_value(history(&db, DEVICE_ID, hour, hour + 2 * HOUR_MS, false)?)?;
    // (10 x 200 + 5 x 400) / 15 replies = 266.67 us, rounded half-up.
    assert_eq!(
        hourly,
        json!([{"layer":"lan","target":"gateway","points":[
            {"ts_ms":hour,"sample_count":3,"loss_percent":50.0,
             "latency_ms":{"min":0.05,"avg":0.267,"max":0.9},"jitter_ms":0.03},
            {"ts_ms":hour+HOUR_MS,"sample_count":1,"loss_percent":0.0,
             "latency_ms":{"min":0.007,"avg":0.008,"max":0.009},"jitter_ms":0.001}]}])
    );
    let raw = serde_json::to_value(history(&db, DEVICE_ID, hour, hour + HOUR_MS - 1, true)?)?;
    assert_eq!(
        raw[0]["points"],
        json!([
            {"ts_ms":hour,"sample_count":1,"loss_percent":0.0,
             "latency_ms":{"min":0.1,"avg":0.2,"max":0.3},"jitter_ms":0.01},
            {"ts_ms":hour+30_000,"sample_count":1,"loss_percent":50.0,
             "latency_ms":{"min":0.05,"avg":0.4,"max":0.9},"jitter_ms":0.03},
            {"ts_ms":hour+60_000,"sample_count":1,"loss_percent":100.0,
             "latency_ms":{"min":null,"avg":null,"max":null},"jitter_ms":null}])
    );
    Ok(())
}

#[test]
fn record_is_atomic_rejects_stale_ticks_and_replays_as_a_noop() -> Result<()> {
    let mut db = database()?;
    record(&mut db, DEVICE_ID, &tick(30_000))?;
    record(&mut db, DEVICE_ID, &tick(30_000))?;
    assert_eq!(count(&db, "net_probe_samples")?, 5);
    let stored = latest(
        &db,
        DEVICE_ID,
        &["gateway".into(), "dns".into(), "absent".into()],
    )?;
    assert_eq!(
        stored,
        vec![tick(30_000)[0].clone(), tick(30_000)[3].clone()]
    );
    for stale in [
        sample(30_000, "dns", 0, None),
        sample(29_999, "dns", 10, Some((1, 1, 1, 0))),
    ] {
        // The valid first row must roll back with the rejected one.
        assert!(
            record(
                &mut db,
                DEVICE_ID,
                &[sample(60_000, "gateway", 0, None), stale]
            )
            .is_err()
        );
    }
    assert_eq!(count(&db, "net_probe_samples")?, 5);
    db.execute_batch("CREATE TRIGGER fail_rollup BEFORE INSERT ON net_probe_rollup_hourly BEGIN SELECT RAISE(ABORT,'rollup failure'); END;")?;
    assert!(record(&mut db, DEVICE_ID, &tick(60_000)).is_err());
    assert_eq!(count(&db, "net_probe_samples")?, 5);
    db.execute_batch("DROP TRIGGER fail_rollup")?;
    record(&mut db, DEVICE_ID, &tick(60_000))?;
    assert_eq!(count(&db, "net_probe_samples")?, 10);
    // Devices are independent streams.
    record(&mut db, "factory-console", &tick(30_000))?;
    assert_eq!(
        latest(&db, "factory-console", &["gateway".into()])?[0].ts_ms,
        30_000
    );
    assert_eq!(
        latest(&db, DEVICE_ID, &["gateway".into()])?[0].ts_ms,
        60_000
    );
    Ok(())
}

#[test]
fn retention_waits_for_rollups_is_bounded_and_rerun_idempotent() -> Result<()> {
    let mut db = database()?;
    for ts in [1, HOUR_MS - 1, HOUR_MS, HOUR_MS + 1] {
        record(
            &mut db,
            DEVICE_ID,
            &[sample(ts, "gateway", 10, Some((1, 2, 3, 0)))],
        )?;
    }
    let now = 7 * DAY_MS + HOUR_MS;
    let summary = serde_json::to_value(history(&db, DEVICE_ID, 0, now, false)?)?;
    let first: Vec<rusqlite::types::Value> = db.query_row(
        "SELECT * FROM net_probe_rollup_hourly WHERE ts_ms=0",
        [],
        |r| (0..11).map(|i| r.get(i)).collect(),
    )?;
    // A missing summary is never a license to delete its raw bursts.
    db.execute("DELETE FROM net_probe_rollup_hourly WHERE ts_ms=0", [])?;
    assert_eq!(retain(&mut db, now)?, 0);
    db.execute(
        "INSERT INTO net_probe_rollup_hourly VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        rusqlite::params_from_iter(first),
    )?;
    // The cutoff is strict: a burst exactly seven days old stays.
    assert_eq!(retain(&mut db, now)?, 2);
    assert_eq!(retain(&mut db, now)?, 0);
    assert_eq!(
        db.query_row("SELECT MIN(ts_ms) FROM net_probe_samples", [], |r| r
            .get::<_, i64>(0))?,
        HOUR_MS
    );
    assert_eq!(retain(&mut db, now + 1)?, 1);
    assert_eq!(
        serde_json::to_value(history(&db, DEVICE_ID, 0, now, false)?)?,
        summary
    );
    // Direct raw fixture writes are deliberate probes of the batch bound, not ingestion.
    db.execute_batch("WITH RECURSIVE n(x) AS (VALUES(2) UNION ALL SELECT x+1 FROM n WHERE x<1503) INSERT INTO net_probe_samples(device_id,ts_ms,target,layer,sent,received) SELECT 'factory-gpu',x,'gateway','lan',10,0 FROM n")?;
    assert_eq!(retain(&mut db, now)?, 1000);
    assert_eq!(retain(&mut db, now)?, 502);
    assert_eq!(retain(&mut db, now)?, 0);
    Ok(())
}

fn fixture(ticks: i64) -> Result<Connection> {
    let db = database()?;
    db.execute_batch(&format!("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<{ticks}),
        t(target,layer) AS (VALUES('gateway','lan'),('1.1.1.1','wan'),('8.8.8.8','wan'),('dns','dns'),('tailnet','tailnet'))
        INSERT INTO net_probe_samples SELECT d.id,x*30000,target,layer,NULL,10,10-x%3,x%17,x%17+5,x%17+9,x%5
        FROM n, t, (SELECT 'factory-gpu' AS id UNION ALL SELECT 'factory-console') d;
        INSERT INTO net_probe_rollup_hourly SELECT device_id,ts_ms,target,layer,1,10,10,1,1,1,1 FROM net_probe_samples WHERE ts_ms%3600000=0;
        ANALYZE;"))?;
    Ok(db)
}

#[test]
fn hot_queries_use_indexes_and_raw_history_is_bucketed() -> Result<()> {
    let db = fixture(20_000)?;
    let sort = Exception {
        kind: ExceptionKind::ReviewedLegacySort,
        table: "",
        reason: "range-bounded samples group into at most 720 buckets per target; dynamic buckets cannot use a persistent index",
    };
    let registry = Exception {
        kind: ExceptionKind::SmallWholeSetRead,
        table: "k",
        reason: "json_each walks the registry's handful of target keys",
    };
    let device = Value::from(DEVICE_ID);
    let keys = Value::from(r#"["gateway","1.1.1.1","8.8.8.8","dns","tailnet"]"#);
    for (sql, args, table, index, exceptions) in [
        (
            PREVIOUS_SQL,
            vec![device.clone(), "dns".into()],
            "net_probe_samples",
            Some("net_probe_samples_target"),
            vec![],
        ),
        (
            HOUR_SQL,
            vec![
                device.clone(),
                "dns".into(),
                (5 * HOUR_MS).into(),
                (6 * HOUR_MS).into(),
            ],
            "net_probe_samples",
            Some("net_probe_samples_target"),
            vec![],
        ),
        (
            RETAIN_SQL,
            vec![(HOUR_MS).into()],
            "net_probe_samples",
            Some("net_probe_samples_ts"),
            vec![],
        ),
        (
            LATEST_SQL,
            vec![device.clone(), keys],
            "net_probe_samples",
            Some("net_probe_samples_target"),
            vec![registry],
        ),
        (
            RAW_HISTORY_SQL,
            vec![
                device.clone(),
                (DAY_MS).into(),
                (2 * DAY_MS).into(),
                120_001.into(),
            ],
            "net_probe_samples",
            None,
            vec![sort],
        ),
        (
            HOURLY_HISTORY_SQL,
            vec![device.clone(), (DAY_MS).into(), (2 * DAY_MS).into()],
            "net_probe_rollup_hourly",
            None,
            vec![],
        ),
    ] {
        let args: Vec<rusqlite::types::Value> = args
            .into_iter()
            .map(|v| match v {
                Value::String(s) => s.into(),
                v => v.as_i64().unwrap().into(),
            })
            .collect();
        let plan = explain::query_plan(&db, sql, rusqlite::params_from_iter(args))?;
        explain::validate(&plan, &[RequiredSearch { table, index }], &exceptions)
            .map_err(|e| e.context(sql))?;
    }
    let series = history(&db, DEVICE_ID, 0, DAY_MS, true)?;
    assert_eq!(series.len(), 5);
    for s in &series {
        assert!(s.points.len() <= 720);
        assert_eq!(s.points.iter().map(|p| p.sample_count).sum::<i64>(), 2881);
    }
    // The first 120001 ms bucket holds ticks 0..=4, receiving 10, 9, 8, 10, 9 of 50.
    let first = &series[0].points[0];
    assert_eq!((first.ts_ms, first.sample_count), (0, 5));
    assert_eq!(first.loss_percent, 8.0);
    assert_eq!(series[0].target, "gateway");
    assert_eq!(series[1].layer, Layer::Wan);
    Ok(())
}

#[test]
fn record_and_reads_use_constant_statement_counts() -> Result<()> {
    let mut budgets = Vec::new();
    for ticks in [3, 20_000] {
        let mut db = Tracked::new(fixture(ticks)?, |db| db)?;
        let now = (ticks + 1) * 30_000;
        let write = Scope::default();
        db.run(&write, Category::Data, |db| {
            record(db, DEVICE_ID, &tick(now))
        })?;
        let read = Scope::default();
        db.run(&read, Category::Data, |db| -> Result<()> {
            latest(db, DEVICE_ID, &["gateway".into(), "dns".into()])?;
            history(db, DEVICE_ID, now - DAY_MS, now, true)?;
            history(db, DEVICE_ID, now - 30 * DAY_MS, now, false)?;
            Ok(())
        })?;
        let retention = Scope::default();
        db.run(&retention, Category::Data, |db| retain(db, now))?;
        budgets.push((write.counts(), read.counts().data, retention.counts()));
    }
    // One tick: per target, a previous-row read, an insert, an hour read and a rollup upsert.
    assert_eq!(budgets[0].0.data, 5 * 4);
    assert_eq!(budgets[0].1, 3);
    assert_eq!(budgets[0], budgets[1]);
    Ok(())
}
