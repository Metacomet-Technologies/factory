use anyhow::Result;
use axum::{Json, Router, extract::Query, http::StatusCode, response::IntoResponse, routing::get};
use factory_api::{AppState, data, fleet, now_ms, router};
use rusqlite::Connection;
use shared::RequestRecord;
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicI64, Ordering},
    },
    time::Duration,
};

const GAP: &str = "gap: meter ids 340..421 were not fetched (500-request window overflowed)";

fn legacy(path: &Path) -> Result<Connection> {
    let db = Connection::open(path)?;
    db.execute_batch(concat!(
        include_str!("../src/ups_schema.sql"),
        include_str!("../src/devices_schema.sql"),
        include_str!("../src/network_schema.sql")
    ))?;
    db.execute_batch("PRAGMA user_version=3;
        WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<1207)
        INSERT INTO requests SELECT id,1,'legacy fixture' FROM n WHERE id NOT BETWEEN 340 AND 421;
        INSERT INTO ups_samples(ts_ms,energy_mwh,coverage_ms) VALUES(11,13,17);
        INSERT INTO device_samples(device_id,ts_ms,cpu_percent) VALUES('factory-gpu',19,23);
        INSERT INTO net_speed_tests(device_id,started_ms,ended_ms,outcome,error,download_bytes,upload_bytes)
            VALUES('factory-gpu',29,31,'failed','fixture failure',37,41);")?;
    db.execute("INSERT INTO warnings VALUES(?1)", [GAP])?;
    Ok(db)
}

fn scalar(db: &Connection, sql: &str) -> i64 {
    db.query_row(sql, [], |r| r.get(0)).unwrap()
}

fn record(id: i64) -> RequestRecord {
    RequestRecord {
        id,
        ts: now_ms(),
        endpoint: "/api/chat".into(),
        status: 200,
        prompt_eval_count: Some(3),
        eval_count: Some(7),
        total_duration: Some(123_456_789),
        ..Default::default()
    }
}

#[test]
fn offline_migration_preserves_telemetry_reruns_and_restores_backup() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("requests.db");
    let mut db = legacy(&path)?;
    let original = std::fs::read(&path)?;
    assert!(
        data::open(&path)
            .unwrap_err()
            .to_string()
            .contains("migrate --requests-db")
    );
    assert_eq!(std::fs::read(&path)?, original);
    // A SQLite snapshot includes committed WAL frames, unlike copying the main file.
    let backup = temp.path().join("backup.db");
    db.execute_batch(&format!("VACUUM INTO '{}'", backup.display()))?;
    data::initialize(&mut db)?;
    data::initialize(&mut db)?;
    assert_eq!(scalar(&db, "PRAGMA user_version"), 5);
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM requests_before_v4"), 1125);
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM requests"), 0);
    assert_eq!(
        scalar(&db, "SELECT energy_mwh FROM ups_samples WHERE ts_ms=11"),
        13
    );
    assert_eq!(
        db.query_row(
            "SELECT cpu_percent FROM device_samples WHERE ts_ms=19",
            [],
            |r| r.get::<_, f64>(0)
        )?,
        23.0
    );
    assert_eq!(
        scalar(
            &db,
            "SELECT upload_bytes FROM net_speed_tests WHERE started_ms=29"
        ),
        41
    );
    assert_eq!(
        scalar(
            &db,
            "SELECT COUNT(*) FROM warnings WHERE resolved_at_ms IS NULL AND first_id=340 AND last_id=421"
        ),
        1
    );
    assert_eq!(scalar(&db, "SELECT last_after_id FROM sync_state"), 0);
    assert!(
        data::usage_records(&db, 0, vec![])?
            .1
            .iter()
            .any(|w| w.contains("rebuilding"))
    );
    drop(db);
    let saved = Connection::open(&backup)?;
    assert_eq!(
        saved.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))?,
        "ok"
    );
    drop(saved);
    std::fs::copy(&backup, &path)?;
    let mut restored = Connection::open(&path)?;
    assert_eq!(scalar(&restored, "PRAGMA user_version"), 3);
    assert_eq!(scalar(&restored, "SELECT COUNT(*) FROM requests"), 1125);
    assert_eq!(scalar(&restored, "SELECT energy_mwh FROM ups_samples"), 13);
    restored.execute_batch("CREATE TABLE sync_state(collision INTEGER)")?;
    let before = factory_db::migrations::schema_fingerprint(&restored)?;
    assert!(data::initialize(&mut restored).is_err());
    assert_eq!(
        factory_db::migrations::schema_fingerprint(&restored)?,
        before
    );
    assert_eq!(scalar(&restored, "PRAGMA user_version"), 3);
    assert_eq!(scalar(&restored, "SELECT COUNT(*) FROM requests"), 1125);
    restored.execute_batch("DROP TABLE sync_state")?;
    drop(restored);
    for _ in 0..2 {
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_factory-api"))
            .args(["migrate", "--requests-db"])
            .arg(&path)
            .output()?;
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let db = data::open(&path)?;
    assert_eq!(scalar(&db, "PRAGMA user_version"), 5);
    db.pragma_update(None, "user_version", 6)?;
    drop(db);
    assert!(data::open(&path).is_err());
    Ok(())
}

#[tokio::test]
async fn exact_gap_recovery_resumes_committed_pages_and_keeps_unavailable_gaps() -> Result<()> {
    for missing in [false, true] {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("requests.db");
        let mut db = legacy(&path)?;
        data::initialize(&mut db)?;
        drop(db);
        pricing::migrate(temp.path().join("pricing.db"))?;
        let fail = Arc::new(AtomicBool::new(true));
        let fail_request = fail.clone();
        let last_id = Arc::new(AtomicI64::new(1207));
        let source_last_id = last_id.clone();
        let app = Router::new().route(
            "/meter/requests",
            get(move |Query(q): Query<BTreeMap<String, String>>| {
                let fail = fail_request.clone();
                let last_id = source_last_id.clone();
                async move {
                    let cursor: i64 = q["after_id"].parse().unwrap();
                    if fail.load(Ordering::Relaxed) && cursor >= 500 {
                        return StatusCode::SERVICE_UNAVAILABLE.into_response();
                    }
                    let rows: Vec<_> = ((cursor + 1)..=last_id.load(Ordering::Relaxed))
                        .filter(|id| !missing || !(340..=421).contains(id))
                        .take(500)
                        .map(record)
                        .collect();
                    let next = rows.last().map_or(cursor, |r| r.id);
                    ([("next_after_id", next.to_string())], Json(rows)).into_response()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let new_state = || {
            AppState::new(
                url.clone(),
                path.clone(),
                temp.path().join("pricing.db"),
                fleet::Config { nodes: vec![] },
            )
        };
        let state = new_state().await?;
        state.db.clock_synchronized.store(true, Ordering::Release);
        assert!(state.sync_meter().await.is_err());
        let usage = state.usage("30d".into(), 0).await?;
        assert_eq!(usage.totals.requests, 500);
        assert!(usage.warnings.iter().any(|w| w == GAP));
        assert!(usage.warnings.iter().any(|w| w.contains("rebuilding")));
        state.db.close().await?;
        drop(state);
        let db = Connection::open(&path)?;
        assert_eq!(
            scalar(&db, "SELECT last_after_id FROM sync_state"),
            if missing { 582 } else { 500 }
        );
        drop(db);
        fail.store(false, Ordering::Relaxed);
        let state = new_state().await?;
        state.db.clock_synchronized.store(true, Ordering::Release);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let stream_url = format!("http://{}/v1/stream", listener.local_addr()?);
        let app = router(state.clone());
        let api = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut stream = reqwest::get(stream_url).await?;
        state.sync_meter().await?;
        state.sync_meter().await?;
        let usage = state.usage("30d".into(), 0).await?;
        let count = if missing { 1125 } else { 1207 };
        assert_eq!(usage.totals.requests, count);
        assert_eq!(usage.totals.prompt_tokens, count as u64 * 3);
        assert_eq!(usage.totals.output_tokens, count as u64 * 7);
        assert_eq!(usage.warnings.iter().any(|w| w == GAP), missing);
        assert!(!usage.warnings.iter().any(|w| w.contains("rebuilding")));
        if !missing {
            assert!(usage.warnings.is_empty(), "{:?}", usage.warnings);
        }
        // A live control event must arrive without any of the replayed requests.
        last_id.store(1208, Ordering::Relaxed);
        state.sync_meter().await?;
        let frames = tokio::time::timeout(Duration::from_secs(2), async {
            let mut frames = String::new();
            loop {
                let chunk = stream.chunk().await?.expect("SSE remains open");
                frames.push_str(std::str::from_utf8(&chunk)?);
                if frames.contains("event: llm.request") {
                    break;
                }
            }
            anyhow::Ok(frames)
        })
        .await??;
        assert_eq!(frames.matches("event: llm.request").count(), 1);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), stream.chunk())
                .await
                .is_err(),
            "historical requests must not remain queued after the live event"
        );
        drop(stream);
        api.abort();
        state.db.close().await?;
        let db = Connection::open(&path)?;
        assert_eq!(
            scalar(
                &db,
                "SELECT COUNT(*) FROM requests WHERE id BETWEEN 340 AND 421"
            ),
            if missing { 0 } else { 82 }
        );
        assert_eq!(scalar(&db, "SELECT last_after_id FROM sync_state"), 1208);
        server.abort();
    }
    Ok(())
}

#[tokio::test]
async fn catch_up_is_bounded_and_resumes_on_the_next_poll() -> Result<()> {
    let temp = tempfile::tempdir()?;
    pricing::migrate(temp.path().join("pricing.db"))?;
    let app = Router::new().route(
        "/meter/requests",
        get(|Query(q): Query<BTreeMap<String, String>>| async move {
            let cursor: i64 = q["after_id"].parse().unwrap();
            let rows: Vec<_> = (cursor + 1..=10001).take(500).map(record).collect();
            let next = rows.last().map_or(cursor, |r| r.id);
            ([("next_after_id", next.to_string())], Json(rows))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let state = AppState::new(
        url,
        temp.path().join("requests.db"),
        temp.path().join("pricing.db"),
        fleet::Config { nodes: vec![] },
    )
    .await?;
    state.db.clock_synchronized.store(true, Ordering::Release);
    assert!(
        state
            .sync_meter()
            .await
            .unwrap_err()
            .to_string()
            .contains("catch-up incomplete")
    );
    let usage = state.usage("30d".into(), 0).await?;
    assert_eq!(usage.totals.requests, 10000);
    assert!(
        usage
            .warnings
            .iter()
            .any(|w| w.contains("catch-up incomplete"))
    );
    state.sync_meter().await?;
    let usage = state.usage("30d".into(), 0).await?;
    assert_eq!(usage.totals.requests, 10001);
    assert!(usage.warnings.is_empty(), "{:?}", usage.warnings);
    state.db.close().await?;
    server.abort();
    Ok(())
}

#[test]
fn invalid_page_rolls_back_rows_warnings_and_cursor() -> Result<()> {
    let mut db = Connection::open_in_memory()?;
    data::initialize(&mut db)?;
    data::sync(&mut db, vec![record(1)], &[])?;
    for invalid in [
        record(1),
        record(2),
        RequestRecord {
            prompt_eval_count: Some(u64::MAX),
            ..record(5)
        },
        RequestRecord {
            user_key: Some("someone".into()),
            ..record(5)
        },
        RequestRecord {
            latency_ms: f64::NAN,
            ..record(5)
        },
    ] {
        assert!(data::sync(&mut db, vec![record(2), invalid], &[]).is_err());
        assert_eq!(scalar(&db, "SELECT COUNT(*) FROM requests"), 1);
        assert_eq!(scalar(&db, "SELECT last_after_id FROM sync_state"), 1);
        assert_eq!(scalar(&db, "SELECT COUNT(*) FROM warnings"), 0);
    }
    // A deleted cache row must never regress the durable cursor or create a false gap.
    db.execute("DELETE FROM requests", [])?;
    data::sync(&mut db, vec![record(2)], &[])?;
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM warnings"), 0);
    assert_eq!(scalar(&db, "SELECT last_after_id FROM sync_state"), 2);
    Ok(())
}
