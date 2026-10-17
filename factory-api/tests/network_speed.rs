use anyhow::Result;
use factory_api::{
    data,
    network::DEVICE_ID,
    network_history::*,
    network_speed::{SpeedTest, Verdict},
    ups_history::DAY_MS,
};
use factory_db::{
    Category, Scope, Tracked,
    explain::{self, Exception, ExceptionKind, RequiredSearch},
};
use rusqlite::{Connection, types::Value};
use serde_json::json;

fn database() -> Result<Connection> {
    let mut db = Connection::open_in_memory()?;
    data::initialize(&mut db)?;
    Ok(db)
}
fn test(started_ms: i64, verdict: Verdict) -> SpeedTest {
    SpeedTest {
        started_ms,
        ended_ms: started_ms + 9_500,
        verdict,
        download_bytes: 440_000_000,
        upload_bytes: 290_000_000,
        idle_latency_us: Some(8_691),
        download_loaded_latency_us: Some(31_250),
        upload_loaded_latency_us: None,
        colo: Some("EWR".into()),
    }
}
fn ok(started_ms: i64) -> SpeedTest {
    test(
        started_ms,
        Verdict::Ok {
            download_bps: 935_000_000,
            upload_bps: 912_000_000,
        },
    )
}
fn count(db: &Connection) -> Result<i64> {
    Ok(db.query_row("SELECT COUNT(*) FROM net_speed_tests", [], |r| r.get(0))?)
}

#[test]
fn every_verdict_round_trips_as_the_stored_row() -> Result<()> {
    let mut db = database()?;
    assert_eq!(latest_speed_test(&db, DEVICE_ID)?, None);
    let stored = record_speed_test(&mut db, DEVICE_ID, &ok(1_000))?;
    assert_eq!(
        serde_json::to_value(&stored)?,
        json!({"id":1,"started_ms":1000,"ended_ms":10500,"outcome":"ok","error":null,
               "download_bps":935000000,"upload_bps":912000000,
               "download_bytes":440000000,"upload_bytes":290000000,
               "idle_latency_ms":8.691,"download_loaded_latency_ms":31.25,
               "upload_loaded_latency_ms":null,"colo":"EWR"})
    );
    let failed = record_speed_test(
        &mut db,
        DEVICE_ID,
        &test(
            2_000,
            Verdict::Failed("download of 10000000 bytes: HTTP 500".into()),
        ),
    )?;
    assert_eq!(failed.outcome, NetworkSpeedOutcome::Failed);
    assert_eq!(
        failed.error.as_deref(),
        Some("download of 10000000 bytes: HTTP 500")
    );
    assert_eq!((failed.download_bps, failed.upload_bps), (None, None));
    assert_eq!(failed.download_bytes, 440_000_000);
    let timeout = record_speed_test(&mut db, DEVICE_ID, &test(3_000, Verdict::Timeout))?;
    assert_eq!(
        (timeout.outcome, timeout.error.clone(), timeout.download_bps),
        (NetworkSpeedOutcome::Timeout, None, None)
    );
    assert_eq!(latest_speed_test(&db, DEVICE_ID)?, Some(timeout.clone()));
    assert_eq!(
        speed_tests(&db, DEVICE_ID, 2_000)?,
        vec![failed, timeout.clone()]
    );
    assert_eq!(speed_tests(&db, DEVICE_ID, 0)?[0], stored);
    // Devices are independent; an equal start time is ordered by id.
    record_speed_test(&mut db, "factory-console", &ok(9_000))?;
    let tie = record_speed_test(&mut db, DEVICE_ID, &ok(3_000))?;
    assert_eq!(latest_speed_test(&db, DEVICE_ID)?, Some(tie.clone()));
    assert_eq!(
        speed_tests(&db, DEVICE_ID, 3_000)?
            .iter()
            .map(|t| t.id)
            .collect::<Vec<_>>(),
        [timeout.id, tie.id]
    );
    // The schema refuses a failed verdict without its error.
    assert!(
        record_speed_test(
            &mut db,
            DEVICE_ID,
            &test(4_000, Verdict::Failed(String::new()))
        )
        .is_err()
    );
    assert_eq!(count(&db)?, 5);
    Ok(())
}

#[test]
fn retention_keeps_365_days_in_bounded_idempotent_batches() -> Result<()> {
    let mut db = database()?;
    let now = 400 * DAY_MS;
    let cutoff = now - 365 * DAY_MS;
    for (device, started) in [
        (DEVICE_ID, cutoff - 1),
        (DEVICE_ID, cutoff),
        (DEVICE_ID, cutoff + 1),
        ("factory-console", cutoff - 1),
    ] {
        record_speed_test(&mut db, device, &ok(started))?;
    }
    // The cutoff is strict: a test exactly 365 days old stays. Every device is pruned.
    assert_eq!(retain_speed_tests(&mut db, now)?, 2);
    assert_eq!(retain_speed_tests(&mut db, now)?, 0);
    assert_eq!(
        speed_tests(&db, DEVICE_ID, 0)?
            .iter()
            .map(|t| t.started_ms)
            .collect::<Vec<_>>(),
        [cutoff, cutoff + 1]
    );
    assert!(speed_tests(&db, "factory-console", 0)?.is_empty());
    assert_eq!(retain_speed_tests(&mut db, now + 1)?, 1);
    // Direct fixture writes probe the batch bound across two devices.
    db.execute_batch("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1501) INSERT INTO net_speed_tests(device_id,started_ms,ended_ms,outcome,download_bytes,upload_bytes) SELECT CASE x%2 WHEN 0 THEN 'factory-gpu' ELSE 'factory-console' END,x,x,'timeout',0,0 FROM n")?;
    assert_eq!(retain_speed_tests(&mut db, now)?, 1000);
    assert_eq!(retain_speed_tests(&mut db, now)?, 502);
    assert_eq!(retain_speed_tests(&mut db, now)?, 0);
    assert_eq!(count(&db)?, 1);
    // An empty table is a no-op, and early timestamps never underflow the cutoff.
    db.execute("DELETE FROM net_speed_tests", [])?;
    assert_eq!(retain_speed_tests(&mut db, now)?, 0);
    assert_eq!(retain_speed_tests(&mut db, 5)?, 0);
    Ok(())
}

fn fixture(tests: i64) -> Result<Connection> {
    let db = database()?;
    db.execute_batch(&format!("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<{tests})
        INSERT INTO net_speed_tests(device_id,started_ms,ended_ms,outcome,error,download_bps,upload_bps,download_bytes,upload_bytes,idle_latency_us,colo)
        SELECT d.id,x*10800000,x*10800000+9000,CASE x%7 WHEN 0 THEN 'failed' ELSE 'ok' END,CASE x%7 WHEN 0 THEN 'HTTP 500' END,
        CASE x%7 WHEN 0 THEN NULL ELSE 900000000+x END,CASE x%7 WHEN 0 THEN NULL ELSE 800000000+x END,440000000,290000000,8000+x%100,'EWR'
        FROM n, (SELECT 'factory-gpu' AS id UNION ALL SELECT 'factory-console') d;
        ANALYZE;"))?;
    Ok(db)
}

#[test]
fn hot_queries_use_the_started_index() -> Result<()> {
    let db = fixture(20_000)?;
    let devices = Exception {
        kind: ExceptionKind::SmallWholeSetRead,
        table: "device",
        reason: "the recursive skip-scan yields one row per probe device",
    };
    for (sql, args, exceptions) in [
        (
            LATEST_SPEED_SQL,
            vec![Value::from(DEVICE_ID.to_string())],
            vec![],
        ),
        (
            SPEED_TESTS_SQL,
            vec![Value::from(DEVICE_ID.to_string()), (100 * DAY_MS).into()],
            vec![],
        ),
        (SPEED_RETAIN_SQL, vec![(400 * DAY_MS).into()], vec![devices]),
    ] {
        let plan = explain::query_plan(&db, sql, rusqlite::params_from_iter(args))?;
        explain::validate(
            &plan,
            &[RequiredSearch {
                table: if sql == SPEED_RETAIN_SQL {
                    "t"
                } else {
                    "net_speed_tests"
                },
                index: Some("net_speed_tests_started"),
            }],
            &exceptions,
        )
        .map_err(|e| e.context(format!("{sql}\n{plan:?}")))?;
    }
    Ok(())
}

#[test]
fn record_reads_and_retention_use_constant_statement_counts() -> Result<()> {
    let mut budgets = Vec::new();
    for tests in [3, 20_000] {
        let mut db = Tracked::new(fixture(tests)?, |db| db)?;
        let now = (tests + 1) * 10_800_000;
        let write = Scope::default();
        db.run(&write, Category::Data, |db| {
            record_speed_test(db, DEVICE_ID, &ok(now))
        })?;
        let read = Scope::default();
        db.run(&read, Category::Data, |db| -> Result<()> {
            latest_speed_test(db, DEVICE_ID)?;
            speed_tests(db, DEVICE_ID, now - 365 * DAY_MS)?;
            Ok(())
        })?;
        let retention = Scope::default();
        db.run(&retention, Category::Data, |db| retain_speed_tests(db, now))?;
        budgets.push((write.counts(), read.counts(), retention.counts()));
    }
    assert_eq!(budgets[0].0.data, 1);
    assert_eq!(budgets[0].1.data, 2);
    assert_eq!(budgets[0].2.data, 1);
    assert_eq!(budgets[0], budgets[1]);
    Ok(())
}
