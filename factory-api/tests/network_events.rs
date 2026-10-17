use anyhow::Result;
use factory_api::{
    AppState, data, fleet,
    network::{Burst, DEVICE_ID, Layer, NetworkConfig, Rtt, Sample},
    network_diagnosis::{DEFAULT_THRESHOLDS, LinkState, Peak, Reason},
    network_history::*,
};
use factory_db::{
    Category, Scope, Tracked,
    explain::{self, RequiredSearch},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

const TARGETS: [(&str, Layer); 5] = [
    ("gateway", Layer::Lan),
    ("1.1.1.1", Layer::Wan),
    ("8.8.8.8", Layer::Wan),
    ("dns", Layer::Dns),
    ("tailnet", Layer::Tailnet),
];

fn database() -> Result<Connection> {
    let mut db = Connection::open_in_memory()?;
    data::initialize(&mut db)?;
    Ok(db)
}
fn burst(received: u32, avg_us: i64, mdev_us: i64) -> Burst {
    Burst {
        sent: 10,
        received,
        rtt: (received > 0).then_some(Rtt {
            min_us: avg_us,
            avg_us,
            max_us: avg_us,
            mdev_us,
        }),
    }
}
fn fine() -> Burst {
    burst(10, 1_000, 100)
}
/// One tick: `None` leaves a target unsampled, as a broken probe does.
fn tick(ts_ms: i64, bursts: [Option<Burst>; 5]) -> Vec<Sample> {
    TARGETS
        .iter()
        .zip(bursts)
        .filter_map(|(&(target, layer), burst)| {
            Some(Sample {
                ts_ms,
                layer,
                target: target.into(),
                address: Some(target.into()),
                burst: burst?,
            })
        })
        .collect()
}
fn healthy(ts_ms: i64) -> Vec<Sample> {
    tick(ts_ms, [Some(fine()); 5])
}
fn wan(ts_ms: i64, wan: Burst) -> Vec<Sample> {
    tick(
        ts_ms,
        [
            Some(fine()),
            Some(wan),
            Some(wan),
            Some(fine()),
            Some(fine()),
        ],
    )
}

/// A collector process writing ticks to one database.
struct Process<'a> {
    db: &'a mut Connection,
    collector: Collector,
}
impl Process<'_> {
    fn start(db: &mut Connection) -> Process<'_> {
        Process {
            db,
            collector: Collector::default(),
        }
    }
    fn tick(&mut self, samples: Vec<Sample>) -> Result<Value> {
        let ts_ms = samples.first().map_or(0, |s| s.ts_ms);
        let diagnosed = self
            .collector
            .diagnose(ts_ms, &samples, &DEFAULT_THRESHOLDS);
        let changed = record(self.db, DEVICE_ID, &samples, Some(&diagnosed))?;
        self.collector.committed();
        let open: i64 = self.db.query_row(
            "SELECT COUNT(*) FROM net_events WHERE ended_ms IS NULL",
            [],
            |r| r.get(0),
        )?;
        assert!(open <= 1, "one open episode at most");
        let before = snapshot(self.db)?;
        assert_eq!(
            record(self.db, DEVICE_ID, &samples, Some(&diagnosed))?,
            [],
            "a replayed tick changes nothing"
        );
        assert_eq!(snapshot(self.db)?, before);
        Ok(serde_json::to_value(changed)?)
    }
}
fn rows(db: &Connection) -> Result<Value> {
    let mut page = events(db, DEVICE_ID, 200, None)?.unwrap().events;
    page.reverse();
    Ok(serde_json::to_value(page)?)
}
fn snapshot(db: &Connection) -> Result<(Value, i64)> {
    let samples = db.query_row("SELECT COUNT(*) FROM net_probe_samples", [], |r| r.get(0))?;
    Ok((rows(db)?, samples))
}

#[test]
fn episodes_open_track_peaks_change_and_recover() -> Result<()> {
    let mut db = database()?;
    let mut process = Process::start(&mut db);
    assert_eq!(process.tick(healthy(30_000))?, json!([]));
    // Both wan targets lose 30%: degraded by loss, opened with that tick's peaks.
    assert_eq!(
        process.tick(wan(60_000, burst(7, 9_000, 500)))?,
        json!([{"id":1,"state":"degraded","layer":"wan","reason":"loss","started_ms":60_000,
                "ended_ms":null,"end_reason":null,"peak_loss_percent":30.0,
                "peak_rtt_us":9_000,"peak_mdev_us":500}])
    );
    // The same state keeps the row and raises each peak independently.
    assert_eq!(process.tick(wan(90_000, burst(6, 12_000, 300)))?, json!([]));
    assert_eq!(process.tick(wan(120_000, burst(8, 2_000, 900)))?, json!([]));
    // One lost tick is still degraded by loss: the same episode.
    assert_eq!(process.tick(wan(150_000, Burst::lost(10)))?, json!([]));
    assert_eq!(
        rows(process.db)?,
        json!([{"id":1,"state":"degraded","layer":"wan","reason":"loss","started_ms":60_000,
                "ended_ms":null,"end_reason":null,"peak_loss_percent":100.0,
                "peak_rtt_us":12_000,"peak_mdev_us":900}])
    );
    // The second lost tick is down: the degraded row ends as changed and the
    // down row opens at the same tick.
    assert_eq!(
        process.tick(wan(180_000, Burst::lost(10)))?,
        json!([{"id":1,"state":"degraded","layer":"wan","reason":"loss","started_ms":60_000,
                "ended_ms":180_000,"end_reason":"changed","peak_loss_percent":100.0,
                "peak_rtt_us":12_000,"peak_mdev_us":900},
               {"id":2,"state":"down","layer":"wan","started_ms":180_000,
                "ended_ms":null,"end_reason":null,"peak_loss_percent":100.0,
                "peak_rtt_us":null,"peak_mdev_us":null}])
    );
    assert_eq!(
        process.tick(healthy(210_000))?,
        json!([{"id":2,"state":"down","layer":"wan","started_ms":180_000,
                "ended_ms":210_000,"end_reason":"recovered","peak_loss_percent":100.0,
                "peak_rtt_us":null,"peak_mdev_us":null}])
    );
    assert_eq!(process.tick(healthy(240_000))?, json!([]));
    assert_eq!(open_event(&db, DEVICE_ID)?, None);
    assert_eq!(rows(&db)?.as_array().unwrap().len(), 2);
    Ok(())
}

#[test]
fn a_restart_closes_the_previous_process_episode() -> Result<()> {
    let mut db = database()?;
    let mut first = Process::start(&mut db);
    first.tick(wan(30_000, Burst::lost(10)))?;
    first.tick(wan(60_000, Burst::lost(10)))?;
    let down = open_event(&db, DEVICE_ID)?.unwrap();
    assert_eq!(down.state, LinkState::Down { layer: Layer::Wan });
    // Streaks restart, so the still-lost wan is degraded again, not a continuation.
    let mut second = Process::start(&mut db);
    let changed = second.tick(wan(90_000, Burst::lost(10)))?;
    assert_eq!(
        changed,
        json!([{"id":down.id,"state":"down","layer":"wan","started_ms":60_000,
                "ended_ms":90_000,"end_reason":"restart","peak_loss_percent":100.0,
                "peak_rtt_us":null,"peak_mdev_us":null},
               {"id":down.id + 1,"state":"degraded","layer":"wan","reason":"loss","started_ms":90_000,
                "ended_ms":null,"end_reason":null,"peak_loss_percent":100.0,
                "peak_rtt_us":null,"peak_mdev_us":null}])
    );
    // Later ticks of the same process are normal transitions.
    let changed = second.tick(wan(120_000, Burst::lost(10)))?;
    assert_eq!(changed[0]["end_reason"], "changed");
    assert_eq!(changed[1]["state"], "down");
    // A healthy first tick still ends the leftover episode as restart, not recovered.
    let mut third = Process::start(&mut db);
    let changed = third.tick(healthy(150_000))?;
    assert_eq!(changed.as_array().unwrap().len(), 1);
    assert_eq!(changed[0]["end_reason"], "restart");
    assert_eq!(changed[0]["ended_ms"], 150_000);
    // With nothing left open, a restart writes nothing.
    assert_eq!(Process::start(&mut db).tick(healthy(180_000))?, json!([]));
    Ok(())
}

#[test]
fn restart_stays_pending_until_a_tick_commits() -> Result<()> {
    let mut db = database()?;
    Process::start(&mut db).tick(wan(30_000, burst(5, 1_000, 100)))?;
    let mut collector = Collector::default();
    // The first write of the new process fails (the clock is unsynchronized).
    let lost = collector.diagnose(60_000, &healthy(60_000), &DEFAULT_THRESHOLDS);
    assert!(lost.restart);
    let retried = collector.diagnose(90_000, &healthy(90_000), &DEFAULT_THRESHOLDS);
    assert!(
        retried.restart,
        "restart stays pending until a tick commits"
    );
    let changed = record(&mut db, DEVICE_ID, &healthy(90_000), Some(&retried))?;
    assert_eq!(
        (changed.len(), changed[0].end_reason, changed[0].ended_ms),
        (1, Some(NetworkEndReason::Restart), Some(90_000))
    );
    collector.committed();
    assert!(
        !collector
            .diagnose(120_000, &healthy(120_000), &DEFAULT_THRESHOLDS)
            .restart
    );
    Ok(())
}

#[test]
fn unknown_layers_are_never_blamed() -> Result<()> {
    let mut db = database()?;
    let mut process = Process::start(&mut db);
    // Ping is broken: no lan or wan samples, dns and tailnet fine.
    let broken = |ts_ms, dns| tick(ts_ms, [None, None, None, Some(dns), Some(fine())]);
    assert_eq!(process.tick(broken(30_000, fine()))?, json!([]));
    process.tick(broken(60_000, Burst::lost(10)))?;
    process.tick(broken(90_000, Burst::lost(10)))?;
    assert_eq!(
        open_event(process.db, DEVICE_ID)?.unwrap().state,
        LinkState::Down { layer: Layer::Dns }
    );
    // One unsampled wan target does not hide the other's loss.
    process.tick(healthy(120_000))?;
    let half = tick(
        150_000,
        [
            Some(fine()),
            None,
            Some(burst(5, 1_000, 100)),
            Some(fine()),
            Some(fine()),
        ],
    );
    assert_eq!(process.tick(half)?[0]["layer"], "wan");
    // Losing every sample of the faulting layer ends its episode: missing
    // evidence names no fault, so the link reads healthy.
    let changed = process.tick(broken(180_000, fine()))?;
    assert_eq!(changed[0]["end_reason"], "recovered");
    assert_eq!(open_event(&db, DEVICE_ID)?, None);
    Ok(())
}

#[test]
fn event_writes_share_the_sample_transaction_and_reject_stale_ticks() -> Result<()> {
    let mut db = database()?;
    Process::start(&mut db).tick(wan(60_000, burst(5, 1_000, 100)))?;
    let samples = |db: &Connection| -> Result<i64> {
        Ok(db.query_row("SELECT COUNT(*) FROM net_probe_samples", [], |r| r.get(0))?)
    };
    let before = (samples(&db)?, rows(&db)?);
    let stale = Diagnosed {
        ts_ms: 30_000,
        state: LinkState::Healthy,
        peak: None,
        restart: false,
    };
    // The newer samples roll back with the rejected event.
    let error = record(&mut db, DEVICE_ID, &healthy(90_000), Some(&stale)).unwrap_err();
    assert!(error.to_string().contains("did not advance"), "{error:#}");
    assert_eq!((samples(&db)?, rows(&db)?), before);
    db.execute_batch("CREATE TRIGGER fail_event BEFORE UPDATE ON net_events BEGIN SELECT RAISE(ABORT,'event failure'); END;")?;
    let recover = Diagnosed {
        ts_ms: 90_000,
        ..stale
    };
    assert!(record(&mut db, DEVICE_ID, &healthy(90_000), Some(&recover)).is_err());
    assert_eq!((samples(&db)?, rows(&db)?), before);
    db.execute_batch("DROP TRIGGER fail_event")?;
    record(&mut db, DEVICE_ID, &healthy(90_000), Some(&recover))?;
    assert_eq!(samples(&db)?, before.0 + 5);
    assert_eq!(open_event(&db, DEVICE_ID)?, None);
    // A degraded state with no peak still opens a row, with null peaks.
    let degraded = Diagnosed {
        ts_ms: 120_000,
        state: LinkState::Degraded {
            layer: Layer::Dns,
            reason: Reason::Jitter,
        },
        peak: None,
        restart: false,
    };
    let opened = record(&mut db, DEVICE_ID, &[], Some(&degraded))?;
    assert_eq!(opened[0].peak_loss_percent, None);
    let peak = Peak {
        loss_percent: 0.0,
        rtt_us: Some(5),
        mdev_us: None,
    };
    record(
        &mut db,
        DEVICE_ID,
        &[],
        Some(&Diagnosed {
            ts_ms: 150_000,
            peak: Some(peak),
            ..degraded
        }),
    )?;
    let open = open_event(&db, DEVICE_ID)?.unwrap();
    assert_eq!(
        (open.peak_loss_percent, open.peak_rtt_us, open.peak_mdev_us),
        (Some(0.0), Some(5), None)
    );
    Ok(())
}

#[test]
fn event_pages_follow_the_tied_cursor() -> Result<()> {
    let db = database()?;
    // Three episodes share started_ms 2000; the cursor must not skip any.
    db.execute_batch(
        "INSERT INTO net_events(device_id,state,layer,started_ms,ended_ms,end_reason) VALUES
        ('factory-gpu','down','wan',1000,2000,'changed'),
        ('factory-gpu','down','lan',2000,2000,'changed'),
        ('factory-gpu','down','dns',2000,2000,'changed'),
        ('factory-gpu','down','wan',2000,3000,'recovered'),
        ('factory-console','down','wan',2500,NULL,NULL),
        ('factory-gpu','down','tailnet',4000,NULL,NULL);",
    )?;
    let page = |limit, before| -> Result<Option<(Vec<i64>, Option<i64>)>> {
        Ok(events(&db, DEVICE_ID, limit, before)?
            .map(|page| (page.events.iter().map(|e| e.id).collect(), page.next_before)))
    };
    assert_eq!(page(2, None)?, Some((vec![6, 4], Some(4))));
    assert_eq!(page(2, Some(4))?, Some((vec![3, 2], Some(2))));
    assert_eq!(page(2, Some(2))?, Some((vec![1], None)));
    assert_eq!(page(200, Some(3))?, Some((vec![2, 1], None)));
    assert_eq!(page(1, Some(1))?, Some((vec![], None)));
    // Unknown ids and other devices' events are not cursors.
    assert_eq!(page(2, Some(7))?, None);
    assert_eq!(page(2, Some(5))?, None);
    for limit in [0, 201] {
        assert!(events(&db, DEVICE_ID, limit, None).is_err());
    }
    Ok(())
}

fn fixture(events: i64) -> Result<Connection> {
    let db = database()?;
    db.execute_batch(&format!(
        "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<{events})
        INSERT INTO net_events(device_id,state,layer,reason,started_ms,ended_ms,end_reason,peak_loss_percent)
        SELECT d.id,'degraded','wan','loss',x*60000,x*60000+30000,'recovered',30.0
        FROM n, (SELECT 'factory-gpu' AS id UNION ALL SELECT 'factory-console') d;
        INSERT INTO net_events(device_id,state,layer,started_ms) VALUES('factory-gpu','down','lan',{events}*60000+60000);
        WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<{events})
        INSERT INTO net_probe_samples(device_id,ts_ms,target,layer,sent,received,rtt_min_us,rtt_avg_us,rtt_max_us,rtt_mdev_us)
        SELECT 'factory-gpu',x*30000,t.target,t.layer,10,10,1,1,1,0 FROM n,
        (SELECT 'gateway' AS target,'lan' AS layer UNION ALL SELECT '1.1.1.1','wan' UNION ALL SELECT '8.8.8.8','wan' UNION ALL SELECT 'dns','dns' UNION ALL SELECT 'tailnet','tailnet') t;
        ANALYZE;"
    ))?;
    Ok(db)
}

#[test]
fn event_queries_use_their_indexes() -> Result<()> {
    let db = fixture(5_000)?;
    for (sql, args, index) in [
        (
            OPEN_EVENT_SQL,
            vec![Value::from(DEVICE_ID)],
            Some("net_events_open"),
        ),
        (
            EVENTS_SQL,
            vec![
                DEVICE_ID.into(),
                (1_000 * 60_000).into(),
                7.into(),
                50.into(),
            ],
            Some("net_events_started"),
        ),
        (EVENT_CURSOR_SQL, vec![7.into(), DEVICE_ID.into()], None),
    ] {
        let args: Vec<rusqlite::types::Value> = args
            .into_iter()
            .map(|v| match v {
                Value::String(s) => s.into(),
                v => v.as_i64().unwrap().into(),
            })
            .collect();
        let plan = explain::query_plan(&db, sql, rusqlite::params_from_iter(args))?;
        explain::validate(
            &plan,
            &[RequiredSearch {
                table: "net_events",
                index,
            }],
            &[],
        )
        .map_err(|e| e.context(sql))?;
    }
    Ok(())
}

#[test]
fn tick_writes_and_event_reads_use_constant_statement_counts() -> Result<()> {
    let mut budgets = Vec::new();
    for events_before in [3, 5_000] {
        let mut db = Tracked::new(fixture(events_before)?, |db| db)?;
        let now = (events_before + 2) * 60_000;
        let mut counts = Vec::new();
        // Continue the open lan episode, change it, recover, then stay healthy.
        let ticks = [
            (
                Layer::Lan,
                Some(Burst::lost(10)),
                LinkState::Down { layer: Layer::Lan },
            ),
            (
                Layer::Wan,
                Some(burst(5, 1_000, 100)),
                LinkState::Degraded {
                    layer: Layer::Wan,
                    reason: Reason::Loss,
                },
            ),
            (Layer::Wan, None, LinkState::Healthy),
            (Layer::Wan, None, LinkState::Healthy),
        ];
        for (i, (layer, fault, state)) in ticks.into_iter().enumerate() {
            let ts_ms = now + i as i64 * 30_000;
            let samples: Vec<_> = healthy(ts_ms)
                .into_iter()
                .map(|mut s| {
                    if s.layer == layer
                        && let Some(fault) = fault
                    {
                        s.burst = fault;
                    }
                    s
                })
                .collect();
            let diagnosed = Diagnosed {
                ts_ms,
                state,
                peak: (state != LinkState::Healthy).then_some(Peak {
                    loss_percent: 50.0,
                    rtt_us: Some(1_000),
                    mdev_us: Some(100),
                }),
                restart: false,
            };
            let write = Scope::default();
            db.run(&write, Category::Data, |db| {
                record(db, DEVICE_ID, &samples, Some(&diagnosed))
            })?;
            counts.push(write.counts().data);
        }
        let scope = Scope::default();
        db.run(&scope, Category::Data, |db| open_event(db, DEVICE_ID))?;
        let mut reads = vec![scope.counts().data];
        // The fixture's lan episode, which the ticks closed, as a cursor.
        let lan = 2 * events_before + 1;
        for (before, rows) in [
            (None, 200.min(events_before + 2)),
            (Some(lan), 200.min(events_before)),
        ] {
            let scope = Scope::default();
            let page = db
                .run(&scope, Category::Data, |db| {
                    events(db, DEVICE_ID, 200, before)
                })?
                .unwrap();
            assert_eq!(page.events.len() as i64, rows, "{before:?}");
            reads.push(scope.counts().data);
        }
        budgets.push((counts, reads));
    }
    // Per tick: 5 targets x 4 sample statements, the open-event read, then
    // a peak update, a close plus an insert, a close, and nothing. A cursor
    // page adds the cursor lookup.
    assert_eq!(budgets[0], (vec![22, 23, 22, 21], vec![1, 1, 2]));
    assert_eq!(budgets[0], budgets[1]);
    Ok(())
}

async fn serve(state: &AppState, scope: &Scope) -> Result<(String, tokio::task::JoinHandle<()>)> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let app = factory_api::router(state.clone()).layer(axum::Extension(scope.clone()));
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Ok((url, task))
}

#[tokio::test]
async fn endpoints_serve_the_stored_state_and_pages_in_constant_queries() -> Result<()> {
    let client = reqwest::Client::new();
    for n in [3, 600] {
        let dir = tempfile::tempdir()?;
        pricing::migrate(dir.path().join("pricing.db"))?;
        let mut state = AppState::new(
            "http://127.0.0.1:1".into(),
            dir.path().join("requests.db"),
            dir.path().join("pricing.db"),
            fleet::Config { nodes: vec![] },
        )
        .await?;
        state.network = NetworkConfig::default().targets().into();
        state.db.clock_synchronized.store(true, Ordering::Release);
        // n wan outages that each recover, then one still down.
        state
            .db
            .write(&Scope::default(), move |db| {
                let mut collector = Collector::default();
                let mut ts_ms = 30_000;
                let mut write = |samples: Vec<Sample>| -> Result<()> {
                    let tick = collector.diagnose(samples[0].ts_ms, &samples, &DEFAULT_THRESHOLDS);
                    record(db, DEVICE_ID, &samples, Some(&tick))?;
                    collector.committed();
                    Ok(())
                };
                for _ in 0..n {
                    write(wan(ts_ms, Burst::lost(10)))?;
                    write(wan(ts_ms + 30_000, Burst::lost(10)))?;
                    write(healthy(ts_ms + 60_000))?;
                    ts_ms += 90_000;
                }
                write(wan(ts_ms, Burst::lost(10)))?;
                write(wan(ts_ms + 30_000, Burst::lost(10)))?;
                Ok(())
            })
            .await?;
        let get = |path: String, scope: Scope| {
            let state = state.clone();
            let client = client.clone();
            async move {
                let (url, task) = serve(&state, &scope).await?;
                let response = client.get(format!("{url}{path}")).send().await?;
                let status = response.status();
                let body: Value = response.json().await?;
                task.abort();
                anyhow::Ok((status, body, scope.counts().data))
            }
        };
        let (status, body, queries) = get("/v1/network".into(), Scope::default()).await?;
        assert_eq!((status.as_u16(), queries), (200, 3), "/v1/network n={n}");
        let down_ms = 30_000 + n * 90_000 + 30_000;
        assert_eq!(body["state"], json!({"state": "down", "layer": "wan"}));
        assert_eq!(
            body["open_event"],
            json!({"id": 2 * n + 2, "state": "down", "layer": "wan", "started_ms": down_ms,
                   "ended_ms": null, "end_reason": null, "peak_loss_percent": 100.0,
                   "peak_rtt_us": null, "peak_mdev_us": null})
        );
        // Page newest first through every episode with the returned cursor.
        // The first page is one query; each cursor page adds the cursor lookup.
        let mut seen = Vec::new();
        let mut path = "/v1/network/events?limit=200".to_string();
        let mut budget = 1;
        loop {
            let (status, page, queries) = get(path.clone(), Scope::default()).await?;
            assert_eq!((status.as_u16(), queries), (200, budget), "{path}");
            seen.extend(
                page["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|e| e["id"].as_i64().unwrap()),
            );
            if page["next_before"].is_null() {
                break;
            }
            path = format!(
                "/v1/network/events?limit=200&before={}",
                page["next_before"]
            );
            budget = 2;
        }
        assert_eq!(seen, (1..=2 * n + 2).rev().collect::<Vec<_>>(), "n={n}");
        let (_, page, _) = get("/v1/network/events".into(), Scope::default()).await?;
        let events = page["events"].as_array().unwrap();
        assert_eq!(events.len() as i64, (2 * n + 2).min(50));
        assert_eq!(events[0], body["open_event"]);
        assert_eq!(
            (
                events[1]["state"].as_str(),
                events[1]["end_reason"].as_str()
            ),
            (Some("degraded"), Some("changed"))
        );
        if n > 3 {
            assert_eq!(page["next_before"], 2 * n + 2 - 49);
        }
        let unknown = format!("/v1/network/events?before={}", 2 * n + 3);
        for path in [
            "/v1/network/events?limit=0",
            "/v1/network/events?limit=201",
            "/v1/network/events?before=0",
            "/v1/network/events?before=x",
            "/v1/network/events?before_ms=1",
            "/v1/network/events?before_id=3",
            &unknown,
        ] {
            let (status, body, _) = get(path.into(), Scope::default()).await?;
            assert_eq!(status.as_u16(), 400, "{path}");
            assert_eq!(body["error"]["code"], "invalid_query", "{path}");
        }
        let (url, task) = serve(&state, &Scope::default()).await?;
        let post = client
            .post(format!("{url}/v1/network/events"))
            .send()
            .await?;
        assert_eq!(post.status().as_u16(), 405);
        task.abort();
        state.db.close().await?;
    }
    Ok(())
}
