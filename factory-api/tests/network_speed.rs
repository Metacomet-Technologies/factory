use anyhow::Result;
use factory_api::{
    AppState, alerts, data, fleet,
    network::DEVICE_ID,
    network_history::*,
    network_speed::{Direction, Plan, SpeedConfig, SpeedTest, Step, Verdict},
    now_ms, router,
    ups_history::DAY_MS,
};
use factory_db::{
    Category, Scope, Tracked,
    explain::{self, Exception, ExceptionKind, RequiredSearch},
};
use rusqlite::{Connection, types::Value};
use serde_json::json;
use std::{sync::atomic::Ordering, time::Duration};

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
            RECENT_SPEED_SQL,
            vec![Value::from(DEVICE_ID.to_string()), 3.into()],
            vec![],
        ),
        (
            RECENT_OK_SPEED_SQL,
            vec![Value::from(DEVICE_ID.to_string()), 3.into()],
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

#[test]
fn alert_input_skips_unfinished_tests_between_ok_ones() -> Result<()> {
    let mut db = database()?;
    let slow = |started_ms| {
        test(
            started_ms,
            Verdict::Ok {
                download_bps: 404_000_000,
                upload_bps: 900_000_000,
            },
        )
    };
    for t in [
        slow(1_000),
        test(2_000, Verdict::Timeout),
        slow(3_000),
        test(4_000, Verdict::Failed("HTTP 500".into())),
        slow(5_000),
    ] {
        record_speed_test(&mut db, DEVICE_ID, &t)?;
    }
    record_speed_test(&mut db, "factory-console", &ok(6_000))?;
    let input = alert_input(&db, DEVICE_ID)?;
    let started =
        |tests: &[NetworkSpeedTest]| tests.iter().map(|t| t.started_ms).collect::<Vec<_>>();
    assert_eq!(started(&input.recent_ok_tests), [5_000, 3_000, 1_000]);
    assert_eq!(started(&input.recent_tests), [5_000, 4_000, 3_000]);
    assert_eq!(input.open_event, None);
    let mut engine = alerts::Engine::load(alerts::Config::default());
    engine.evaluate(
        10_000,
        &alerts::Signals {
            network: Some(input),
            ..Default::default()
        },
    );
    assert_eq!(
        engine
            .view()
            .active
            .iter()
            .map(|a| a.key.as_str())
            .collect::<Vec<_>>(),
        ["network:throughput_low"]
    );
    // The alert read is three statements however many tests are stored.
    let mut budgets = Vec::new();
    for tests in [3, 20_000] {
        let mut db = Tracked::new(fixture(tests)?, |db| db)?;
        let read = Scope::default();
        db.run(&read, Category::Data, |db| alert_input(db, DEVICE_ID))?;
        budgets.push(read.counts());
    }
    assert_eq!(budgets[0].data, 3);
    assert_eq!(budgets[0], budgets[1]);
    Ok(())
}

async fn state(dir: &tempfile::TempDir) -> Result<AppState> {
    pricing::migrate(dir.path().join("pricing.db"))?;
    let state = AppState::new(
        "http://127.0.0.1:1".into(),
        dir.path().join("requests.db"),
        dir.path().join("pricing.db"),
        fleet::Config { nodes: vec![] },
    )
    .await?;
    state.db.clock_synchronized.store(true, Ordering::Release);
    Ok(state)
}
async fn serve(state: &AppState, scope: &Scope) -> Result<(String, tokio::task::JoinHandle<()>)> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let app = router(state.clone()).layer(axum::Extension(scope.clone()));
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Ok((url, task))
}

#[tokio::test]
async fn speed_test_endpoint_filters_by_range_with_one_statement() -> Result<()> {
    for n in [3i64, 1001] {
        let dir = tempfile::tempdir()?;
        let state = state(&dir).await?;
        // Embedders and tests never run a speed test unless they install one.
        assert!(state.speed_test.is_none());
        let now = now_ms();
        // Hourly tests going back n hours, plus one per range boundary.
        let ages: Vec<i64> = (0..n)
            .map(|i| i * 3_600_000 + 60_000)
            .chain([2 * DAY_MS, 10 * DAY_MS, 100 * DAY_MS, 400 * DAY_MS])
            .collect();
        state
            .db
            .write(&Scope::default(), move |db| {
                for age in ages.iter().rev() {
                    record_speed_test(db, DEVICE_ID, &ok(now - age))?;
                }
                record_speed_test(db, "factory-console", &ok(now))?;
                Ok(())
            })
            .await?;
        let client = reqwest::Client::new();
        let within = |days: i64| {
            (0..n)
                .filter(|i| i * 3_600_000 + 60_000 < days * DAY_MS)
                .count()
        };
        for (query, range, expected) in [
            ("", "7d", within(7) + 1),
            ("?range=24h", "24h", within(1)),
            ("?range=7d", "7d", within(7) + 1),
            ("?range=30d", "30d", within(30) + 2),
            ("?range=365d", "365d", within(365) + 3),
        ] {
            let scope = Scope::default();
            let (url, task) = serve(&state, &scope).await?;
            let body: serde_json::Value = client
                .get(format!("{url}/v1/network/speed-tests{query}"))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            task.abort();
            assert_eq!(scope.counts().data, 1, "{query} n={n}");
            assert_eq!(body["range"], range);
            let tests = body["tests"].as_array().unwrap();
            assert_eq!(tests.len(), expected, "{query} n={n}");
            let starts: Vec<i64> = tests
                .iter()
                .map(|t| t["started_ms"].as_i64().unwrap())
                .collect();
            assert!(
                starts.windows(2).all(|pair| pair[0] <= pair[1]),
                "oldest first"
            );
            assert_eq!(tests.last().unwrap()["download_bps"], 935_000_000);
            assert_eq!(tests.last().unwrap()["idle_latency_ms"], 8.691);
        }
        let (url, task) = serve(&state, &Scope::default()).await?;
        for (method, path, status) in [
            ("GET", "/v1/network/speed-tests?range=1h", 400),
            ("GET", "/v1/network/speed-tests?range=", 400),
            ("GET", "/v1/network/speed-tests?range=7d&range=30d", 400),
            ("POST", "/v1/network/speed-tests", 405),
        ] {
            let response = client
                .request(method.parse()?, format!("{url}{path}"))
                .send()
                .await?;
            assert_eq!(response.status(), status, "{method} {path}");
            if status == 400 {
                assert_eq!(
                    response.json::<serde_json::Value>().await?["error"]["code"],
                    "invalid_range"
                );
            }
        }
        task.abort();
        state.db.close().await?;
    }
    Ok(())
}

/// Loopback speed endpoints: `/ok` answers, `/fail` returns HTTP 500.
async fn speed_server() -> Result<String> {
    use axum::{
        extract::{Path, Query},
        http::StatusCode,
        response::IntoResponse,
        routing::{get, post},
    };
    #[derive(serde::Deserialize)]
    struct Down {
        bytes: usize,
    }
    let app = axum::Router::new()
        .route(
            "/{mode}/__down",
            get(
                |Path(mode): Path<String>, Query(q): Query<Down>| async move {
                    if mode == "fail" {
                        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                    }
                    (
                        [("cf-meta-colo", "SBX"), ("cf-meta-ip", "203.0.113.9")],
                        vec![0u8; q.bytes],
                    )
                        .into_response()
                },
            ),
        )
        .route(
            "/{mode}/__up",
            post(|body: axum::body::Bytes| async move {
                ([("cf-meta-colo", "SBX")], body.len().to_string())
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Ok(url)
}
static STEPS: [Step; 2] = [
    Step {
        direction: Direction::Download,
        bytes: 3000,
        count: 2,
    },
    Step {
        direction: Direction::Upload,
        bytes: 2000,
        count: 1,
    },
];
fn config(base: String) -> SpeedConfig {
    SpeedConfig {
        base,
        latency_target: "127.0.0.1".parse().unwrap(),
        interval: Duration::from_secs(120),
        plan: Plan {
            steps: &STEPS,
            slow_request: Duration::from_secs(1),
            cap: Duration::from_secs(20),
        },
    }
}

#[tokio::test]
async fn collector_stores_then_streams_and_respects_the_clock() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let mut state = state(&dir).await?;
    let speed = speed_server().await?;
    state.speed_test = Some(config(format!("{speed}/ok")));
    let (url, task) = serve(&state, &Scope::default()).await?;
    let client = reqwest::Client::new();
    let mut stream = client.get(format!("{url}/v1/stream")).send().await?;
    state.collect_speed_test().await;
    let mut frames = String::new();
    let frame = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            frames.push_str(std::str::from_utf8(&stream.chunk().await?.unwrap())?);
            if let Some(rest) = frames.split("event: network.speedtest\ndata: ").nth(1)
                && let Some((line, _)) = rest.split_once('\n')
            {
                return anyhow::Ok(serde_json::from_str::<serde_json::Value>(line)?);
            }
        }
    })
    .await??;
    let status = serde_json::to_value(state.network().await?)?;
    assert_eq!(frame["data"], status["latest_speed_test"]);
    let row = &frame["data"];
    assert_eq!(row["outcome"], "ok");
    assert_eq!(
        (row["download_bytes"].as_i64(), row["upload_bytes"].as_i64()),
        (Some(6000), Some(2000))
    );
    assert_eq!(row["colo"], "SBX");
    assert!(row["download_bps"].as_i64().unwrap() > 0 && row["upload_bps"].as_i64().unwrap() > 0);
    assert!(row["idle_latency_ms"].as_f64().is_some(), "{row}");
    assert!(!row.to_string().contains("203.0.113.9"));
    assert_eq!(status["warnings"], json!([]));

    // A failed test is a stored outcome, not a warning.
    state.speed_test = Some(config(format!("{speed}/fail")));
    state.collect_speed_test().await;
    let status = serde_json::to_value(state.network().await?)?;
    let failed = &status["latest_speed_test"];
    assert_eq!(failed["outcome"], "failed");
    assert!(
        failed["error"]
            .as_str()
            .unwrap()
            .starts_with("download of 3000 bytes: "),
        "{failed}"
    );
    assert!(failed["download_bps"].is_null() && failed["upload_bps"].is_null());
    assert_eq!(status["warnings"], json!([]));

    // Without a synchronized clock no test runs, so nothing is moved or stored.
    state.db.clock_synchronized.store(false, Ordering::Release);
    state.collect_speed_test().await;
    let status = serde_json::to_value(state.network().await?)?;
    assert_eq!(status["latest_speed_test"]["id"], failed["id"]);

    // A storage error is the warning.
    state.db.clock_synchronized.store(true, Ordering::Release);
    state
        .db
        .write(&Scope::default(), |db| {
            Ok(db.execute_batch("CREATE TRIGGER refuse BEFORE INSERT ON net_speed_tests BEGIN SELECT RAISE(ABORT,'disk full'); END;")?)
        })
        .await?;
    state.collect_speed_test().await;
    let status = serde_json::to_value(state.network().await?)?;
    assert_eq!(status["latest_speed_test"]["id"], failed["id"]);
    assert_eq!(status["warnings"], json!(["network speedtest: disk full"]));
    task.abort();
    state.db.close().await?;
    Ok(())
}

#[test]
fn speed_flags_are_validated_at_parse_time() -> Result<()> {
    for (flag, value, message) in [
        ("--network-speed-url", "ftp://speed.example", "http(s)"),
        ("--network-speed-url", "https://speed.example/?x=1", "query"),
        ("--network-speed-interval-s", "119", "119"),
    ] {
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_factory-api"))
            .env_clear()
            .args([flag, value])
            .output()?;
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(output.status.code(), Some(2), "{flag} {value}: {stderr}");
        assert!(stderr.contains(message), "{flag} {value}: {stderr}");
    }
    Ok(())
}
