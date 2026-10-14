use anyhow::Result;
use factory_api::{AppState, data, fleet, now_ms, router, ups::UpsCurrent, ups_history::*};
use factory_db::{
    Scope,
    explain::{self, Exception, ExceptionKind, RequiredSearch},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

fn database() -> Result<Connection> {
    let mut db = Connection::open_in_memory()?;
    data::initialize(&mut db)?;
    Ok(db)
}
fn sample(ts_ms: i64, status: &str) -> UpsCurrent {
    let flags: Vec<_> = status.split_whitespace().collect();
    serde_json::from_value(json!({"ts_ms":ts_ms,"status":status,"flags":flags,
        "on_line":flags.contains(&"OL"),"on_battery":flags.contains(&"OB"),
        "low_battery":flags.contains(&"LB"),"replace_battery":flags.contains(&"RB"),
        "charge_percent":80.0,"runtime_s":900,"load_w":144.0,"input_v":121.0,
        "output_v":120.0,"battery_v":25.9,"test_result":"passed"}))
    .unwrap()
}

#[test]
fn migration_adopts_captured_schema_and_is_atomic_strict_and_repeatable() -> Result<()> {
    for legacy in [false, true] {
        for analyzed in [false, true] {
            let mut db = Connection::open_in_memory()?;
            if legacy {
                db.execute_batch(include_str!("../src/requests_legacy.sql"))?;
                db.execute("INSERT INTO requests VALUES(19,1700000000000,'{}')", [])?;
                if analyzed {
                    db.execute_batch("ANALYZE")?;
                }
            }
            data::initialize(&mut db)?;
            data::initialize(&mut db)?;
            assert_eq!(
                db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))?,
                1
            );
            if legacy {
                assert_eq!(
                    db.query_row("SELECT id FROM requests", [], |r| r.get::<_, i64>(0))?,
                    19
                );
            }
            for table in ["ups_samples", "ups_rollup_hourly", "ups_events", "settings"] {
                assert_eq!(
                    db.query_row(
                        "SELECT strict FROM pragma_table_list WHERE name=?1",
                        [table],
                        |r| r.get::<_, i64>(0)
                    )?,
                    1
                );
            }
            for sql in [
                "INSERT INTO ups_events(kind,started_ms) VALUES('invalid',1)",
                "INSERT INTO ups_events(kind,started_ms,ended_ms,end_reason) VALUES('on_battery',10,9,'recovered')",
                "INSERT INTO ups_events(kind,started_ms,ended_ms,end_reason) VALUES('on_battery',10,11,'invalid')",
                "INSERT INTO ups_samples(ts_ms,energy_mwh,coverage_ms) VALUES(-1,0,0)",
                "INSERT INTO ups_samples(ts_ms,energy_mwh,coverage_ms) VALUES(1,-1,0)",
                "INSERT INTO ups_samples(ts_ms,energy_mwh,coverage_ms) VALUES(1,0.5,0)",
                "INSERT INTO settings VALUES('rate',0.5)",
            ] {
                assert!(db.execute(sql, []).is_err(), "{sql}");
            }
            db.pragma_update(None, "user_version", 2)?;
            assert!(data::initialize(&mut db).is_err());
        }
    }
    let mut db = Connection::open_in_memory()?;
    let sql = include_str!("../src/ups_schema.sql");
    let manifest = [factory_db::migrations::Migration {
        version: 1,
        sql,
        checksum: 0xf7820cc3e88268c1,
    }];
    assert!(
        factory_db::migrations::run(
            &mut db,
            &manifest,
            None,
            |_, _| Ok(()),
            |_, _| anyhow::bail!("injected failure")
        )
        .is_err()
    );
    assert!(factory_db::migrations::schema_fingerprint(&db)?.is_empty());
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))?,
        0
    );
    db.execute_batch("CREATE TABLE unexpected(id INTEGER)")?;
    assert!(data::initialize(&mut db).is_err());
    Ok(())
}

#[test]
fn energy_gap_cap_rounding_overflow_and_missing_values() -> Result<()> {
    assert_eq!(sample_energy(Some(144.0), 30_000)?, 1200);
    assert_eq!(sample_energy(Some(144.0), 30_001)?, 0);
    assert_eq!(sample_energy(None, 10_000)?, 0);
    assert!(sample_energy(Some(f64::MAX), 10_000).is_err());
    assert!(sample_energy(Some(-1.0), 10_000).is_err());
    assert_eq!(cost(1, 499)?, 0);
    assert_eq!(cost(1, 500)?, 1);
    assert_eq!(cost(3, 500)?, 2);
    assert!(cost(i64::MAX, 10_000_000).is_err());
    let mut db = database()?;
    let mut collector = Collector::new(&db, HOUR_MS)?;
    for (delta, watts, charge) in [
        (0, Some(72.0), Some(80.0)),
        (10_000, Some(144.0), None),
        (40_000, Some(216.0), Some(50.0)),
        (70_001, Some(999.0), Some(20.0)),
        (80_001, None, None),
    ] {
        let mut s = sample(HOUR_MS + delta, "OB");
        s.load_w = watts;
        s.charge_percent = charge;
        collector.record(&mut db, Some(&s), s.ts_ms)?;
    }
    let raw: Vec<i64> = db
        .prepare("SELECT energy_mwh FROM ups_samples ORDER BY ts_ms")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    assert_eq!(raw, vec![0, 400, 1800, 0, 0]);
    let points = history(&db, HOUR_MS, 2 * HOUR_MS, false)?;
    assert_eq!(points[0].sample_count, 5);
    assert_eq!(points[0].charge_percent.avg, Some(50.0));
    assert_eq!(points[0].load_w.avg, Some(357.75));
    assert_eq!(
        db.query_row("SELECT on_battery_s FROM ups_rollup_hourly", [], |r| r
            .get::<_, f64>(0))?,
        50.0
    );
    put_settings(
        &db,
        UpsSettings {
            electricity_rate_micro_usd_per_kwh: Some(175_000),
            battery_installed_ms: None,
        },
        2 * HOUR_MS,
    )?;
    let e = energy(&db, HOUR_MS, 2 * HOUR_MS)?.energy;
    assert_eq!(e.energy_mwh, 2200);
    assert_eq!(e.cost_nano_usd, Some(385_000));
    assert!((e.coverage_percent - 100.0 * 50.0 / 3600.0).abs() < 1e-9);
    // Overflow must fail rather than wrap or return an approximate float total.
    db.execute("UPDATE ups_rollup_hourly SET energy_mwh=?1", [i64::MAX])?;
    assert!(energy(&db, HOUR_MS, 2 * HOUR_MS).is_err());
    put_settings(
        &db,
        UpsSettings {
            electricity_rate_micro_usd_per_kwh: None,
            battery_installed_ms: None,
        },
        2 * HOUR_MS,
    )?;
    collector.record(&mut db, Some(&sample(2 * HOUR_MS, "OL")), 2 * HOUR_MS)?;
    db.execute(
        "UPDATE ups_rollup_hourly SET energy_mwh=1 WHERE ts_ms=?1",
        [2 * HOUR_MS],
    )?;
    assert!(energy(&db, HOUR_MS, 3 * HOUR_MS).is_err());
    Ok(())
}

#[test]
fn events_transitions_restart_minima_and_tied_cursor() -> Result<()> {
    let mut db = database()?;
    let mut c = Collector::new(&db, 0)?;
    assert!(c.record(&mut db, Some(&sample(1, "OL")), 1)?.is_empty());
    let opened = c.record(&mut db, Some(&sample(10_001, "OB LB RB")), 10_001)?;
    assert_eq!(
        opened.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(),
        ["on_battery", "low_battery", "replace_battery"]
    );
    let mut low = sample(20_001, "OB");
    low.charge_percent = Some(19.0);
    low.runtime_s = Some(120);
    let closed = c.record(&mut db, Some(&low), low.ts_ms)?;
    assert_eq!(closed.len(), 2);
    assert!(
        closed
            .iter()
            .all(|e| e.end_reason.as_deref() == Some("recovered"))
    );
    assert!(c.record(&mut db, None, 50_000)?.is_empty());
    assert_eq!(c.record(&mut db, None, 50_001)?[0].kind, "comms_lost");
    assert!(c.record(&mut db, None, 60_001)?.is_empty());
    let mut recovered = sample(70_001, "OL");
    recovered.test_result = Some("failed".into());
    let changes = c.record(&mut db, Some(&recovered), recovered.ts_ms)?;
    assert_eq!(changes.len(), 4); // OB close, comms close, self-test open and close.
    let ob = changes.iter().find(|e| e.kind == "on_battery").unwrap();
    assert_eq!(
        (ob.min_charge_percent, ob.min_runtime_s),
        (Some(19.0), Some(120))
    );
    assert_eq!(changes.last().unwrap().ended_ms, Some(70_001));
    assert_eq!(changes.last().unwrap().detail.as_deref(), Some("failed"));
    c.record(&mut db, Some(&sample(80_001, "OB")), 80_001)?;
    let mut restarted = Collector::new(&db, 90_001)?;
    assert!(restarted.record(&mut db, None, 100_001)?.is_empty());
    let changes = restarted.record(&mut db, Some(&sample(110_001, "OB")), 110_001)?;
    assert_eq!(changes.len(), 2);
    assert_eq!(changes[0].end_reason.as_deref(), Some("restart"));
    assert!(changes[1].ended_ms.is_none());
    let changes = restarted.record(&mut db, Some(&sample(120_001, "OL")), 120_001)?;
    assert_eq!(changes[0].end_reason.as_deref(), Some("recovered"));
    let all = events(&db, 200, i64::MAX, i64::MAX)?.events;
    let mut ids = Vec::new();
    let (mut ms, mut id) = (i64::MAX, i64::MAX);
    loop {
        let page = events(&db, 1, ms, id)?;
        if page.events.is_empty() {
            break;
        }
        ids.push(page.events[0].id);
        ms = page.next_before_ms.unwrap();
        id = page.next_before_id.unwrap();
    }
    assert_eq!(ids, all.iter().map(|e| e.id).collect::<Vec<_>>());
    Ok(())
}

#[test]
fn retention_requires_committed_rollup_is_bounded_and_restart_idempotent() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("requests.db");
    let mut db = data::open(&path)?;
    let mut c = Collector::new(&db, 0)?;
    for ts in [1, HOUR_MS - 1, HOUR_MS, HOUR_MS + 1] {
        c.record(&mut db, Some(&sample(ts, "OL")), ts)?;
    }
    // Inject a failed aggregation. Both raw insertion and summary must roll back.
    db.execute_batch("CREATE TRIGGER fail_rollup BEFORE INSERT ON ups_rollup_hourly BEGIN SELECT RAISE(ABORT,'rollup failure'); END;")?;
    assert!(
        c.record(&mut db, Some(&sample(HOUR_MS + 2, "OB")), HOUR_MS + 2)
            .is_err()
    );
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM ups_samples", [], |r| r
            .get::<_, i64>(0))?,
        4
    );
    db.execute_batch("DROP TRIGGER fail_rollup")?;
    let summary = serde_json::to_value(history(&db, 0, 2 * HOUR_MS, false)?)?;
    // A missing summary is never a license to delete its raw readings.
    db.execute("DELETE FROM ups_rollup_hourly WHERE ts_ms=0", [])?;
    assert_eq!(retain(&mut db, 7 * DAY_MS + HOUR_MS)?, 0);
    drop(db);
    let mut db = data::open(&path)?;
    // Restore the first summary using a disposable copy of its raw inputs.
    let mut copy = database()?;
    let mut cc = Collector::new(&copy, 0)?;
    for ts in [1, HOUR_MS - 1] {
        cc.record(&mut copy, Some(&sample(ts, "OL")), ts)?;
    }
    let values: Vec<rusqlite::types::Value> =
        copy.query_row("SELECT * FROM ups_rollup_hourly", [], |r| {
            (0..15).map(|i| r.get(i)).collect()
        })?;
    db.execute(
        "INSERT INTO ups_rollup_hourly VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        rusqlite::params_from_iter(values),
    )?;
    assert_eq!(retain(&mut db, 7 * DAY_MS + HOUR_MS)?, 2);
    assert_eq!(retain(&mut db, 7 * DAY_MS + HOUR_MS)?, 0);
    assert_eq!(
        db.query_row("SELECT MIN(ts_ms) FROM ups_samples", [], |r| r
            .get::<_, i64>(0))?,
        HOUR_MS
    );
    assert_eq!(
        serde_json::to_value(history(&db, 0, 2 * HOUR_MS, false)?)?,
        summary
    );
    assert_eq!(retain(&mut db, 7 * DAY_MS + HOUR_MS + 1)?, 1);
    // Direct raw fixture writes are deliberate corruption probes, not ingestion.
    db.execute_batch("WITH RECURSIVE n(x) AS (VALUES(2) UNION ALL SELECT x+1 FROM n WHERE x<1502) INSERT INTO ups_samples(ts_ms,energy_mwh,coverage_ms) SELECT x,0,0 FROM n")?;
    assert_eq!(retain(&mut db, 8 * DAY_MS)?, 1000);
    assert_eq!(retain(&mut db, 8 * DAY_MS)?, 502);
    assert_eq!(retain(&mut db, 8 * DAY_MS)?, 0);
    Ok(())
}

#[test]
fn indexed_queries_and_downsampling_boundaries() -> Result<()> {
    let db = database()?;
    db.execute_batch("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO ups_samples(ts_ms,load_w,energy_mwh,coverage_ms) SELECT x*10000,x%17,0,0 FROM n;
        INSERT INTO ups_events(kind,started_ms,ended_ms,end_reason) SELECT 'self_test',ts_ms,ts_ms,'recovered' FROM ups_samples;
        INSERT INTO ups_rollup_hourly SELECT ts_ms,1,1,1,1,1,1,1,1,1,1,1,1,1,1 FROM ups_samples WHERE ts_ms%3600000=0;
        ANALYZE;")?;
    for (sql, args, table, index, grouped) in [
        (
            RAW_HISTORY_SQL,
            vec![DAY_MS - HOUR_MS, DAY_MS, 5001],
            "ups_samples",
            None,
            true,
        ),
        (
            HOURLY_HISTORY_SQL,
            vec![HOUR_MS, DAY_MS],
            "ups_rollup_hourly",
            None,
            false,
        ),
        (
            ENERGY_SQL,
            vec![HOUR_MS, DAY_MS, 10_000],
            "ups_samples",
            None,
            false,
        ),
        (
            EVENTS_SQL,
            vec![DAY_MS, 5000, 200],
            "ups_events",
            Some("ups_events_started"),
            false,
        ),
        (
            ALERT_EVENTS_SQL,
            vec![DAY_MS],
            "ups_events",
            Some("ups_events_started"),
            false,
        ),
    ] {
        let plan = explain::query_plan(&db, sql, rusqlite::params_from_iter(args))?;
        let exceptions = if grouped {
            vec![Exception {
                kind: ExceptionKind::ReviewedLegacySort,
                table: "",
                reason: "range-bounded samples group into at most 720 time buckets; dynamic range buckets cannot use a persistent index",
            }]
        } else {
            vec![]
        };
        explain::validate(&plan, &[RequiredSearch { table, index }], &exceptions)?;
    }
    let points = history(&db, 0, DAY_MS, true)?;
    assert!(points.len() <= 720);
    assert_eq!(points.iter().map(|p| p.sample_count).sum::<i64>(), 8641);
    assert_eq!(points[0].load_w.min, Some(0.0));
    assert_eq!(points[0].load_w.max, Some(12.0));
    assert_eq!(points[0].load_w.avg, Some(6.0));
    Ok(())
}

#[test]
fn alert_history_includes_outage_start_and_restart_segments_only() -> Result<()> {
    let mut db = database()?;
    let mut collector = Collector::new(&db, 0)?;
    // A preceding self-test blip must not contaminate the outage minima.
    let mut blip = sample(1, "OB");
    blip.charge_percent = Some(1.0);
    collector.record(&mut db, Some(&blip), 1)?;
    collector.record(&mut db, Some(&sample(10_001, "OL")), 10_001)?;
    collector.record(&mut db, Some(&sample(20_001, "OB")), 20_001)?;
    let mut lower = sample(30_001, "OB");
    lower.charge_percent = Some(37.0);
    lower.runtime_s = Some(401);
    collector.record(&mut db, Some(&lower), 30_001)?;
    let mut restarted = Collector::new(&db, 40_001)?;
    restarted.record(&mut db, Some(&sample(40_001, "OB")), 40_001)?;
    restarted.record(&mut db, Some(&sample(50_001, "OL")), 50_001)?;
    let events = alert_events(&db, 25_001)?;
    assert_eq!(events.len(), 2);
    let original = events.iter().find(|e| e.started_ms == 20_001).unwrap();
    assert_eq!(original.end_reason.as_deref(), Some("restart"));
    assert_eq!(original.min_charge_percent, Some(37.0));
    assert_eq!(original.min_runtime_s, Some(401));
    let subsequent = events.iter().find(|e| e.started_ms == 40_001).unwrap();
    assert_eq!(subsequent.end_reason.as_deref(), Some("recovered"));
    assert!(alert_events(&db, 50_002)?.is_empty());
    Ok(())
}

#[tokio::test]
async fn endpoint_contract_and_constant_query_budgets() -> Result<()> {
    for n in [3, 1001] {
        let dir = tempfile::tempdir()?;
        pricing::migrate(dir.path().join("pricing.db"))?;
        let state = AppState::new(
            "http://127.0.0.1:1".into(),
            dir.path().join("requests.db"),
            dir.path().join("pricing.db"),
            fleet::Config { nodes: vec![] },
        )
        .await?;
        state.db.clock_synchronized.store(true, Ordering::Release);
        let now = now_ms();
        state
            .db
            .write(&Scope::default(), move |db| {
                let mut c = Collector::new(db, now - 20_000_000)?;
                for i in 0..n {
                    let s = sample(now - (n - i) * 10_000, if i % 2 == 0 { "OL" } else { "OB" });
                    c.record(db, Some(&s), s.ts_ms)?;
                }
                Ok(())
            })
            .await?;
        let scope = Scope::default();
        let outage_events = state
            .db
            .requests
            .read(&scope, move |db| alert_events(db, now - 20_000))
            .await?;
        assert_eq!(scope.counts().data, 1, "UPS alert history n={n}");
        assert_eq!(outage_events.len(), 1);
        let client = reqwest::Client::new();
        for (path, budget) in [
            ("/v1/ups/history?range=1h", 1),
            ("/v1/ups/history?range=24h", 1),
            ("/v1/ups/history?range=7d", 1),
            ("/v1/ups/history?range=30d", 1),
            ("/v1/ups/history?range=365d", 1),
            ("/v1/ups/events?limit=200", 1),
            ("/v1/ups/energy?range=1h", 2),
            ("/v1/ups/energy?range=24h", 2),
            ("/v1/ups/energy?range=7d", 2),
            ("/v1/ups/energy?range=30d", 2),
            ("/v1/ups/energy?range=365d", 2),
            ("/v1/settings/ups", 1),
        ] {
            let scope = Scope::default();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
            let addr = listener.local_addr()?;
            let app = router(state.clone()).layer(axum::Extension(scope.clone()));
            let task = tokio::spawn(async move { axum::serve(listener, app).await });
            let body: Value = client
                .get(format!("http://{addr}{path}"))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            assert_eq!(scope.counts().data, budget, "{path} n={n}");
            if path.contains("history") {
                assert!(!body.as_array().unwrap().is_empty());
            }
            if path.contains("energy") {
                if !path.ends_with("range=1h") {
                    assert_eq!(body["energy_mwh"], 400 * (n - 1));
                }
                assert!(body["gpu_energy_mwh"].is_null());
            }
            if path == "/v1/settings/ups" {
                let before = scope.counts().data;
                let values =
                    json!({"electricity_rate_micro_usd_per_kwh":175000,"battery_installed_ms":now});
                let body: Value = client
                    .put(format!("http://{addr}{path}"))
                    .json(&values)
                    .send()
                    .await?
                    .error_for_status()?
                    .json()
                    .await?;
                assert_eq!(body, values);
                assert_eq!(scope.counts().data - before, 1);
                for invalid in [
                    json!({}),
                    json!({"electricity_rate_micro_usd_per_kwh":0.5,"battery_installed_ms":null}),
                    json!({"electricity_rate_micro_usd_per_kwh":10000001,"battery_installed_ms":null}),
                    json!({"electricity_rate_micro_usd_per_kwh":0,"battery_installed_ms":now+DAY_MS}),
                ] {
                    assert_eq!(
                        client
                            .put(format!("http://{addr}{path}"))
                            .json(&invalid)
                            .send()
                            .await?
                            .status(),
                        400
                    );
                }
                let body: Value = client
                    .get(format!("http://{addr}{path}"))
                    .send()
                    .await?
                    .json()
                    .await?;
                assert_eq!(body, values);
                for bad in [
                    "/v1/ups/history?range=2h",
                    "/v1/ups/energy?range=2h",
                    "/v1/ups/events?limit=201",
                    "/v1/ups/events?limit=0",
                    "/v1/ups/events?before_id=1",
                ] {
                    assert_eq!(
                        client
                            .get(format!("http://{addr}{bad}"))
                            .send()
                            .await?
                            .status(),
                        400
                    );
                }
            }
            task.abort();
        }
        state.db.close().await?;
    }
    Ok(())
}

#[test]
fn gpu_history_must_cover_range() -> Result<()> {
    let points: Vec<shared::GpuSample> = (0..=4)
        .map(|i| shared::GpuSample {
            ts: i * 15_000,
            index: 0,
            memory_used_mib: 0.0,
            memory_total_mib: 0.0,
            utilization_percent: 0.0,
            temperature_c: 0.0,
            power_w: 72.0 + (i as f64) * 36.0,
        })
        .collect();
    let intervals = [
        (0, 15_000),
        (15_000, 30_000),
        (30_000, 45_000),
        (45_000, 60_000),
    ];
    assert_eq!(gpu_energy(&points, &intervals)?, Some(2700));
    // One UPS interval rounds once and takes its right endpoint, not an
    // average of GPU readings or a sum rounded at GPU cadence.
    assert_eq!(gpu_energy(&points, &[(0, 30_000)])?, Some(1200));
    assert_eq!(gpu_energy(&points[2..], &[(0, 30_000)])?, Some(1200));
    assert_eq!(gpu_energy(&points[2..], &[(0, 29_999)])?, Some(1200));
    assert_eq!(gpu_energy(&points[2..], &[(-1, 29_999)])?, None);
    assert_eq!(gpu_energy(&points, &[(80_000, 100_000)])?, None);
    assert_eq!(gpu_energy(&points[3..], &intervals)?, None);
    // Nearby endpoint readings do not excuse a >30s GPU hole spanning the
    // UPS interval. The same hole wholly inside a UPS outage is irrelevant.
    let sparse = [points[0].clone(), points[3].clone(), points[4].clone()];
    assert_eq!(gpu_energy(&sparse, &[(10_000, 20_000)])?, None);
    assert_eq!(gpu_energy(&sparse, &[(45_000, 60_000)])?, Some(900));
    assert_eq!(
        gpu_energy(&[points[0].clone(), points[4].clone()], &intervals)?,
        None
    );
    Ok(())
}

#[tokio::test]
async fn gpu_energy_uses_only_ups_intervals_and_warns_instead_of_clamping() -> Result<()> {
    // Cross an hourly boundary: intervals from both rollups must be included,
    // but the 70s UPS outage must not be.
    let base = now_ms() / HOUR_MS * HOUR_MS - HOUR_MS - 30_000;
    for (name, gpu_w, missing, expected, warning) in [
        ("short window", 72.0, false, Some(400), false),
        ("UPS gap", 72.0, false, Some(600), false),
        ("GPU gap", 72.0, true, None, false),
        ("GPU exceeds UPS", 288.0, false, None, true),
    ] {
        let points: Vec<_> = (-360..=360)
            .filter(|i| !missing || !(-3..=3).contains(i))
            .map(|i| shared::GpuSample {
                ts: base + i * 10_000,
                index: 0,
                memory_used_mib: 0.0,
                memory_total_mib: 0.0,
                utilization_percent: 0.0,
                temperature_c: 0.0,
                power_w: gpu_w,
            })
            .collect();
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let upstream_addr = upstream.local_addr()?;
        let upstream_app = axum::Router::new().route(
            "/meter/gpu/history",
            axum::routing::get(move || async move { axum::Json(points) }),
        );
        let upstream_task = tokio::spawn(async move { axum::serve(upstream, upstream_app).await });
        let dir = tempfile::tempdir()?;
        pricing::migrate(dir.path().join("pricing.db"))?;
        let state = AppState::new(
            format!("http://{upstream_addr}"),
            dir.path().join("requests.db"),
            dir.path().join("pricing.db"),
            fleet::Config { nodes: vec![] },
        )
        .await?;
        state.db.clock_synchronized.store(true, Ordering::Release);
        state
            .db
            .write(&Scope::default(), move |db| {
                let mut collector = Collector::new(db, base)?;
                let deltas = if name == "short window" {
                    vec![0, 10_000, 20_000]
                } else {
                    vec![0, 10_000, 20_000, 90_000, 100_000]
                };
                for delta in deltas {
                    let s = sample(base + delta, "OL");
                    collector.record(db, Some(&s), s.ts_ms)?;
                }
                Ok(())
            })
            .await?;
        let scope = Scope::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let app = router(state.clone()).layer(axum::Extension(scope.clone()));
        let task = tokio::spawn(async move { axum::serve(listener, app).await });
        let client = reqwest::Client::new();
        let body: Value = client
            .get(format!("http://{addr}/v1/ups/energy?range=24h"))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        assert_eq!(
            body["energy_mwh"],
            if name == "short window" { 800 } else { 1200 },
            "{name}"
        );
        assert_eq!(body["gpu_energy_mwh"], json!(expected), "{name}");
        assert_eq!(scope.counts().data, 2, "{name}");
        let usage: Value = client
            .get(format!("http://{addr}/v1/llm/usage?range=24h"))
            .send()
            .await?
            .json()
            .await?;
        assert_eq!(
            usage["warnings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|w| w.as_str().unwrap().starts_with("energy:")),
            warning,
            "{name}"
        );
        task.abort();
        upstream_task.abort();
        state.db.close().await?;
    }
    Ok(())
}
