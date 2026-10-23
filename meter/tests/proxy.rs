use axum::{
    Router,
    body::{Body, Bytes},
    http::{Request, Response, StatusCode},
    routing::post,
};
use futures_util::stream;
use meter::{
    AppState,
    db::{Db, Event},
};
use serde_json::{Value, json};
use shared::{GpuSample, RequestRecord};
use std::{
    convert::Infallible,
    net::SocketAddr,
    time::{Duration, Instant},
};
use tokio::net::TcpListener;

fn open(path: &std::path::Path) -> Db {
    meter::migrate::migrate(None, Some(path), false).unwrap();
    Db::open(path).unwrap()
}

async fn serve(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    serve_on(router, "127.0.0.1:0").await
}

async fn serve_on(router: Router, address: &str) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind(address).await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    (url, task)
}

#[tokio::test]
async fn sigterm_drains_writes_and_closes_wal() {
    use std::os::unix::fs::PermissionsExt;
    tokio::time::timeout(Duration::from_secs(30), async {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("meter.db");
        meter::migrate::migrate(None, Some(&path), false).unwrap();
        for (name, output) in [
            ("nvidia-smi", "0, 100, 12000, 5, 40, 20"),
            ("tailscale", "{}"),
        ] {
            let script = directory.path().join(name);
            std::fs::write(&script, format!("#!/bin/sh\necho '{output}'\n")).unwrap();
            std::fs::set_permissions(script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let (upstream, task) = serve(Router::new().fallback(|| async {
            axum::Json(
                json!({"model":"shutdown", "done":true, "prompt_eval_count":13, "eval_count":7}),
            )
        }))
        .await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_meter"))
            .env("PATH", directory.path())
            .args([
                "--listen",
                &address.to_string(),
                "--upstream",
                &upstream,
                "--gpu-sample-interval",
                "3600",
                "--db-path",
            ])
            .arg(&path)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        loop {
            assert!(
                child.try_wait().unwrap().is_none(),
                "meter exited during startup"
            );
            if let Ok(response) = client
                .get(format!("http://{address}/meter/gpu/history"))
                .send()
                .await
            {
                let rows: Vec<Value> = response.json().await.unwrap();
                if !rows.is_empty() {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        for _ in 0..32 {
            let response = client
                .post(format!("http://{address}/api/generate"))
                .json(&json!({"model":"shutdown", "stream":false}))
                .send()
                .await
                .unwrap();
            assert!(response.status().is_success());
            assert_eq!(response.json::<Value>().await.unwrap()["eval_count"], 7);
        }
        let wal = path.with_extension("db-wal");
        assert!(std::fs::metadata(&wal).unwrap().len() > 0);
        assert!(
            tokio::process::Command::new("kill")
                .args(["-TERM", &child.id().unwrap().to_string()])
                .status()
                .await
                .unwrap()
                .success()
        );
        let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            !wal.exists() || std::fs::metadata(&wal).unwrap().len() == 0,
            "WAL remains after SIGTERM"
        );
        let db = rusqlite::Connection::open_with_flags(
            format!("file:{}?mode=ro&immutable=1", path.display()),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )
        .unwrap();
        let counts: (i64, i64, i64) = db
            .query_row(
                "SELECT COUNT(*), SUM(prompt_eval_count), SUM(eval_count) FROM requests",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(counts, (32, 416, 224));
        assert!(
            db.query_row("SELECT COUNT(*) FROM gpu_samples", [], |r| r
                .get::<_, i64>(0))
                .unwrap()
                >= 1
        );
        task.abort();
    })
    .await
    .expect("SIGTERM test timed out");
}

#[tokio::test]
async fn slow_ndjson_is_incremental_and_written_once() {
    tokio::time::timeout(Duration::from_secs(30), async {
    let upstream = Router::new().route("/api/generate", post(|| async {
        let chunks = stream::unfold(0, |index| async move {
            let line = match index {
                0 => "{\"response\":\"first\",\"done\":false}\n",
                1 => "{\"response\":\"second\",\"done\":false}\n",
                2 => "{\"model\":\"demo\",\"done\":true,\"prompt_eval_count\":13,\"eval_count\":7,\"prompt_eval_duration\":100000000,\"eval_duration\":200000000,\"total_duration\":700000000}\n",
                _ => return None,
            };
            if index > 0 { tokio::time::sleep(Duration::from_millis(350)).await; }
            Some((Ok::<_, Infallible>(Bytes::from_static(line.as_bytes())), index + 1))
        });
        Response::builder().status(201).header("content-type", "application/x-ndjson").header("x-upstream", "preserved").body(Body::from_stream(chunks)).unwrap()
    }));
    let (upstream, upstream_task) = serve(upstream).await;
    let directory = tempfile::tempdir().unwrap();
    let db = open(&directory.path().join("meter.db"));
    let (proxy, proxy_task) = serve(meter::router(AppState::new(upstream, db))).await;
    let client = reqwest::Client::new();
    let started = Instant::now();
    let mut response = client
        .post(format!("{proxy}/api/generate"))
        .json(&json!({"model":"demo", "stream":true}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(response.headers()["x-upstream"], "preserved");
    let first = tokio::time::timeout(Duration::from_millis(250), response.chunk())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(started.elapsed() < Duration::from_millis(250));
    assert_eq!(first, "{\"response\":\"first\",\"done\":false}\n");
    let second = response.chunk().await.unwrap().unwrap();
    assert!(started.elapsed() >= Duration::from_millis(300));
    assert!(started.elapsed() < Duration::from_millis(650));
    assert_eq!(second, "{\"response\":\"second\",\"done\":false}\n");
    let last = response.chunk().await.unwrap().unwrap();
    assert!(started.elapsed() >= Duration::from_millis(650));
    assert!(last.ends_with(b"\n"));
    assert!(response.chunk().await.unwrap().is_none());
    let records: Vec<RequestRecord> = client
        .get(format!("{proxy}/meter/requests"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(
        (records[0].prompt_eval_count, records[0].eval_count),
        (Some(13), Some(7))
    );
    assert_eq!(records[0].status, 201);
    assert!(records[0].stream);
    assert_eq!(records[0].client_ip, "127.0.0.1");
    assert!(records[0].error.is_none());
    let stats: Value = client
        .get(format!("{proxy}/meter/stats?range=24h&model=demo"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(stats[0]["requests"], 1);
    assert_eq!(stats[0]["avg_prompt_tokens_per_second"], 130.0);
    assert_eq!(stats[0]["avg_generation_tokens_per_second"], 35.0);
    assert_eq!(stats[0]["p95_total_latency_ms"], 700.0);
    proxy_task.abort();
    upstream_task.abort();
    }).await.expect("slow NDJSON test timed out");
}

#[tokio::test]
async fn loopback_clients_use_machine_hostname() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let hostname = std::process::Command::new("hostname").output().unwrap();
        assert!(hostname.status.success());
        let hostname = String::from_utf8(hostname.stdout).unwrap();
        let (upstream, upstream_task) = serve(Router::new().fallback(|| async { "ok" })).await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        for (address, ip) in [("127.0.0.1:0", "127.0.0.1"), ("[::1]:0", "::1")] {
            let directory = tempfile::tempdir().unwrap();
            let db = open(&directory.path().join("meter.db"));
            let (proxy, task) =
                serve_on(meter::router(AppState::new(upstream.clone(), db)), address).await;
            assert_eq!(
                client
                    .get(format!("{proxy}/api/version"))
                    .header("x-forwarded-for", "203.0.113.1")
                    .send()
                    .await
                    .unwrap()
                    .text()
                    .await
                    .unwrap(),
                "ok"
            );
            let records: Vec<RequestRecord> = client
                .get(format!("{proxy}/meter/requests"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].client_ip, ip);
            assert_eq!(records[0].client_hostname, hostname.trim());
            task.abort();
        }
        upstream_task.abort();
    })
    .await
    .expect("loopback test timed out");
}

#[tokio::test]
async fn request_cursor_pages_without_gaps_and_preserves_legacy_behavior() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let directory = tempfile::tempdir().unwrap();
        let db = open(&directory.path().join("meter.db"));
        let records = (1..=1200)
            .map(|index| RequestRecord {
                id: index,
                ts: 1200 - index,
                endpoint: format!("/request/{index}"),
                status: 200,
                ..Default::default()
            })
            .collect();
        db.import(records, vec![]).await.unwrap();
        let (proxy, task) = serve(meter::router(AppState::new(
            "http://127.0.0.1:1".into(),
            db.clone(),
        )))
        .await;
        let client = reqwest::Client::new();
        for (query, count) in [("", 100), ("?limit=7", 7), ("?limit=10000", 1200)] {
            let response = client
                .get(format!("{proxy}/meter/requests{query}"))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            assert!(response.headers().get("next_after_id").is_none());
            assert!(response.headers().get("oldest_retained_id").is_none());
            let rows: Vec<RequestRecord> = response.json().await.unwrap();
            assert_eq!(rows.len(), count);
            assert_eq!(
                rows.iter().map(|row| row.id).collect::<Vec<_>>(),
                (1201 - count as i64..=1200).rev().collect::<Vec<_>>()
            );
        }
        let mut cursor = 0;
        let mut ids = Vec::new();
        for count in [500, 500, 200, 0] {
            let response = client
                .get(format!("{proxy}/meter/requests?after_id={cursor}"))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            let next: i64 = response.headers()["next_after_id"]
                .to_str()
                .unwrap()
                .parse()
                .unwrap();
            // Lowest stored ID, from the page's own snapshot; absent when empty.
            assert_eq!(
                response
                    .headers()
                    .get("oldest_retained_id")
                    .map(|v| v.to_str().unwrap().to_owned()),
                (count > 0).then(|| "1".to_owned())
            );
            let rows: Vec<RequestRecord> = response.json().await.unwrap();
            assert_eq!(rows.len(), count);
            assert_eq!(next, cursor + count as i64);
            for row in rows {
                assert_eq!(row.endpoint, format!("/request/{}", row.id));
                ids.push(row.id);
            }
            cursor = next;
        }
        assert_eq!(ids, (1..=1200).collect::<Vec<_>>());
        for (after_id, limit, end) in [(498, 137, 635), (0, 5000, 1200)] {
            let response = client
                .get(format!(
                    "{proxy}/meter/requests?after_id={after_id}&limit={limit}"
                ))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            assert_eq!(response.headers()["next_after_id"], end.to_string());
            let rows: Vec<RequestRecord> = response.json().await.unwrap();
            assert_eq!(
                rows.iter().map(|row| row.id).collect::<Vec<_>>(),
                (after_id + 1..=end).collect::<Vec<_>>()
            );
        }
        for query in [
            "after_id=0&limit=0",
            "after_id=0&limit=5001",
            "limit=10001",
            "after_id=-1",
            "after_id=invalid",
            "after_id=9223372036854775808",
        ] {
            assert_eq!(
                client
                    .get(format!("{proxy}/meter/requests?{query}"))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::BAD_REQUEST
            );
        }
        // A client at the end must still see rows appended after its last page.
        db.send(Event::Request(Box::new(RequestRecord {
            status: 200,
            ..Default::default()
        })));
        let rows: Vec<RequestRecord> = client
            .get(format!("{proxy}/meter/requests?after_id={cursor}&limit=1"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, 1201);
        let health: Value = client
            .get(format!("{proxy}/meter/health"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(health["status"], "ok");
        assert_eq!(health["version"], include_str!("../../VERSION").trim());
        assert!(!health["git_sha"].as_str().unwrap().is_empty());
        assert!(health["git_dirty"].is_boolean());
        assert!(health["built_at_ms"].as_u64().unwrap() > 1_700_000_000_000);
        assert_eq!(
            health["inputs_fingerprint"],
            env!("FACTORY_INPUTS_FINGERPRINT")
        );
        let schema: Value = client
            .get(format!("{proxy}/meter/openapi.json"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let request_schema = &schema["paths"]["/meter/requests"]["get"];
        assert!(
            request_schema["parameters"]
                .as_array()
                .unwrap()
                .iter()
                .any(|parameter| parameter["name"] == "after_id")
        );
        assert!(request_schema["responses"]["200"]["headers"]["next_after_id"].is_object());
        assert!(request_schema["responses"]["200"]["headers"]["oldest_retained_id"].is_object());
        task.abort();
    })
    .await
    .expect("cursor test timed out");
}

#[tokio::test]
async fn arbitrary_endpoints_errors_openai_and_internal_contract() {
    tokio::time::timeout(Duration::from_secs(30), async {
    let upstream = Router::new().fallback(|request: Request<Body>| async move {
        let path = request.uri().path().to_owned();
        if path.starts_with("/meter") { panic!("internal endpoint forwarded"); }
        if path.starts_with("/v1/") {
            let body = if path == "/v1/completions" { "{\"choices\":[]}" } else { "{\"model\":\"code\",\"usage\":{\"prompt_tokens\":23,\"completion_tokens\":2,\"total_tokens\":25}}" };
            return Response::builder().header("content-type", "application/json").body(Body::from(body)).unwrap();
        }
        assert_eq!(request.uri().query(), Some("x=%2F&x=2"));
        assert_eq!(request.headers()["x-client"], "untouched");
        let bytes = axum::body::to_bytes(request.into_body(), usize::MAX).await.unwrap();
        Response::builder().status(418).header("x-repeated", "one").header("x-repeated", "two").body(Body::from(bytes)).unwrap()
    });
    let (upstream, upstream_task) = serve(upstream).await;
    let directory = tempfile::tempdir().unwrap();
    let db = open(&directory.path().join("meter.db"));
    let (proxy, proxy_task) = serve(meter::router(AppState::new(upstream, db.clone()))).await;
    let client = reqwest::Client::new();
    for endpoint in ["/api/embed", "/api/unknown"] {
        let response = client
            .post(format!("{proxy}{endpoint}?x=%2F&x=2"))
            .header("x-client", "untouched")
            .body("raw\0body")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::IM_A_TEAPOT);
        assert_eq!(response.headers().get_all("x-repeated").iter().count(), 2);
        assert_eq!(response.bytes().await.unwrap(), "raw\0body");
    }
    for endpoint in ["/v1/chat/completions", "/v1/completions"] {
        client
            .post(format!("{proxy}{endpoint}"))
            .json(&json!({"model":"code", "stream":false}))
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
    }
    let records: Vec<RequestRecord> = client
        .get(format!("{proxy}/meter/requests?limit=10"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(records.len(), 4);
    assert_eq!(records[0].model.as_deref(), Some("code"));
    assert_eq!(records[0].eval_count, None);
    assert_eq!(records[1].prompt_eval_count, Some(23));
    assert_eq!(records[1].usage.as_ref().unwrap()["total_tokens"], 25);
    assert!(!records[1].stream);
    assert_eq!(records[2].error.as_deref(), Some("raw\0body"));
    for path in [
        "/meter/missing",
        "/meter/stats?range=bogus",
        "/meter/requests?limit=0",
        "/meter/gpu/history?range=bogus",
    ] {
        assert!(
            client
                .get(format!("{proxy}{path}"))
                .send()
                .await
                .unwrap()
                .status()
                .is_client_error()
        );
    }
    assert_eq!(
        client
            .post(format!("{proxy}/meter/health"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
    let schema: Value = client
        .get(format!("{proxy}/meter/openapi.json"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(schema["paths"].as_object().unwrap().len(), 6);
    assert!(
        schema["components"]["schemas"]["RequestRecord"]["properties"]["eval_count"].is_object()
    );
    let sample = GpuSample {
        ts: meter::now_ms(),
        index: 0,
        memory_used_mib: 200.0,
        memory_total_mib: 12000.0,
        utilization_percent: 37.0,
        temperature_c: 51.0,
        power_w: 62.0,
    };
    let mut expired = sample.clone();
    expired.ts -= 8 * 86_400_000;
    db.send(Event::Gpu(vec![expired.clone(), sample.clone()]));
    let history_url = format!("{proxy}/meter/gpu/history?range=30d");
    let history = |client: reqwest::Client| {
        let url = history_url.clone();
        async move {
        client
            .get(url)
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap()
        }
    };
    // Expired raw samples are deleted only after a verified rollup includes them.
    let unrolled = (history)(client.clone()).await;
    assert_eq!(unrolled.as_array().unwrap().len(), 2);
    assert!(unrolled.as_array().unwrap().iter().all(|p| p.get("samples").is_none()));
    let progress = db.rollups().await.unwrap();
    assert!(progress.caught_up && progress.verified);
    db.send(Event::Gpu(vec![]));
    let history = (history)(client.clone()).await;
    // One hourly mean for the pruned day, then the raw sample: never both.
    assert_eq!(history.as_array().unwrap().len(), 2);
    assert_eq!(history[0]["samples"], 1);
    assert_eq!(history[0]["ts"], expired.ts - expired.ts % 3_600_000);
    assert_eq!(history[0]["utilization_percent"], 37.0);
    assert!(history[1].get("samples").is_none());
    assert_eq!(history[1]["ts"], sample.ts);
    let health: Value = client.get(format!("{proxy}/meter/health")).send().await.unwrap().json().await.unwrap();
    assert_eq!(health["maintenance"]["status"], "ok");
    // A storage failure must be visible without changing the upstream response.
    let connection = rusqlite::Connection::open(directory.path().join("meter.db")).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_requests BEFORE INSERT ON requests BEGIN SELECT RAISE(FAIL, 'test storage failure'); END;").unwrap();
    let response = client
        .post(format!("{proxy}/v1/completions"))
        .json(&json!({"model":"code"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.text().await.unwrap(), "{\"choices\":[]}");
    assert_eq!(
        client
            .get(format!("{proxy}/meter/health"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    proxy_task.abort();
    upstream_task.abort();
    }).await.expect("proxy contract test timed out");
}

#[tokio::test]
async fn stats_quantiles_rates_and_model_filter() {
    tokio::time::timeout(Duration::from_secs(30), async {
    let upstream = Router::new().route("/api/chat", post(|request: Request<Body>| async {
        let input: Value = serde_json::from_slice(&axum::body::to_bytes(request.into_body(), usize::MAX).await.unwrap()).unwrap();
        let index = input["case"].as_u64().unwrap() as usize;
        axum::Json(json!({"model": input["model"], "done":true,
            "prompt_eval_count": ([10,20,30,40][index]), "eval_count": ([1,3,5,7][index]),
            "prompt_eval_duration": ([Some(1_000_000_000_u64),Some(4_000_000_000),Some(0),None][index]),
            "eval_duration": ([Some(1_000_000_000_u64),Some(1_000_000_000),None,Some(0)][index]),
            "total_duration": ([100_000_000_u64,200_000_000,300_000_000,4_000_000_000][index])}))
    }));
    let (upstream, upstream_task) = serve(upstream).await;
    let directory = tempfile::tempdir().unwrap();
    let (proxy, proxy_task) = serve(meter::router(AppState::new(
        upstream,
        open(&directory.path().join("meter.db")),
    )))
    .await;
    let client = reqwest::Client::new();
    for (model, count) in [("quoted'model", 4), ("other", 1)] {
        for index in 0..count {
            client
                .post(format!("{proxy}/api/chat"))
                .json(&json!({"model":model, "case":index, "stream":false}))
                .send()
                .await
                .unwrap()
                .bytes()
                .await
                .unwrap();
        }
    }
    let stats: Value = client
        .get(format!("{proxy}/meter/stats?model=quoted%27model&range=7d"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(stats.as_array().unwrap().len(), 1);
    assert_eq!(stats[0]["requests"], 4);
    assert_eq!(stats[0]["input_tokens"], 100);
    assert_eq!(stats[0]["output_tokens"], 16);
    assert_eq!(stats[0]["avg_prompt_tokens_per_second"], 7.5);
    assert_eq!(stats[0]["avg_generation_tokens_per_second"], 2.0);
    assert_eq!(stats[0]["p50_total_latency_ms"], 200.0);
    assert_eq!(stats[0]["p95_total_latency_ms"], 4000.0);
    let empty: Value = client
        .get(format!("{proxy}/meter/stats?model=absent"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(empty, json!([]));
    proxy_task.abort();
    upstream_task.abort();
    }).await.expect("stats test timed out");
}

#[tokio::test]
async fn overflow_never_waits_for_sqlite_counts_rows_and_drains_one_episode() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("meter.db");
        let db = open(&path);
        let (upstream, upstream_task) = serve(Router::new().fallback(|| async { "unblocked" })).await;
        let (proxy, proxy_task) = serve(meter::router(AppState::new(upstream, db.clone()))).await;
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        let pool = db.pool.clone();
        let blocker = tokio::spawn(async move {
            pool.write(&Default::default(), move |_| {
                started.send(()).unwrap();
                blocked.recv_timeout(Duration::from_secs(5))?;
                Ok(())
            }).await.unwrap();
        });
        ready.await.unwrap();
        let row = RequestRecord { status: 200, ..Default::default() };
        for _ in 0..1024 { db.send(Event::Request(Box::new(row.clone()))); }
        assert_eq!(db.queue_status().queue_depth, 1024);
        for _ in 0..7 { db.send(Event::Request(Box::new(row.clone()))); }
        let sample = GpuSample { ts: meter::now_ms(), index: 0, memory_used_mib: 1.0, memory_total_mib: 2.0, utilization_percent: 3.0, temperature_c: 4.0, power_w: 5.0 };
        db.send(Event::Gpu(vec![sample.clone(); 3]));
        db.send(Event::Gpu(vec![sample; 2]));
        // The writer remains blocked until AFTER the complete proxy response.
        let text = tokio::time::timeout(Duration::from_millis(500), async {
            reqwest::get(format!("{proxy}/api/version")).await.unwrap().text().await.unwrap()
        }).await.expect("proxy waited for the blocked writer");
        assert_eq!(text, "unblocked");
        assert_eq!(db.queue_status().dropped_requests, 8);
        assert_eq!(db.queue_status().dropped_gpu_samples, 5);
        release.send(()).unwrap();
        blocker.await.unwrap();
        while db.queue_status().queue_depth != 0 { tokio::time::sleep(Duration::from_millis(5)).await; }
        let health: Value = reqwest::get(format!("{proxy}/meter/health")).await.unwrap().json().await.unwrap();
        assert_eq!(health["status"], "ok");
        assert_eq!(health["dropped_requests"], 8);
        assert_eq!(health["dropped_gpu_samples"], 5);
        assert_eq!(health["queue_depth"], 0);
        db.close().await.unwrap();
        let conn = rusqlite::Connection::open(&path).unwrap();
        assert_eq!(conn.query_row("SELECT count(*) FROM requests", [], |r| r.get::<_,i64>(0)).unwrap(), 1024);
        let episodes: Vec<(i64,i64,i64,i64)> = conn.prepare("SELECT started_at_ms,ended_at_ms,dropped_requests,dropped_gpu_samples FROM drop_episodes").unwrap()
            .query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap().collect::<Result<_,_>>().unwrap();
        assert_eq!(episodes.len(), 1);
        assert!(episodes[0].1 >= episodes[0].0);
        assert_eq!((episodes[0].2,episodes[0].3), (8,5));
        proxy_task.abort();
        upstream_task.abort();
    }).await.expect("overflow test timed out");
}

#[tokio::test]
async fn endpoint_budgets_plans_settings_and_openapi() {
    use factory_db::{
        Scope,
        explain::{self, Exception, ExceptionKind, RequiredSearch},
    };
    tokio::time::timeout(Duration::from_secs(30), async {
        for size in [3, 10_001] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("meter.db");
            let db = open(&path);
            let now = meter::now_ms();
            let rows = (1..=size)
                .map(|id| RequestRecord {
                    id,
                    ts: now - ((id - 1) % 365) * 86_400_000,
                    status: 200,
                    endpoint: "/api/chat".into(),
                    model: (id % 3 != 0).then(|| "model".into()),
                    prompt_eval_count: Some(13),
                    eval_count: (id % 2 != 0).then_some(7),
                    ..Default::default()
                })
                .collect();
            let gpu = (0..size)
                .map(|id| GpuSample {
                    ts: now - (id % 7) * 86_400_000,
                    index: (id % 2) as u32,
                    memory_used_mib: 10.0,
                    memory_total_mib: 100.0,
                    utilization_percent: 37.0,
                    temperature_c: 45.0,
                    power_w: 80.0,
                })
                .collect();
            db.import(rows, gpu).await.unwrap();
            db.pool
                .write(&Scope::default(), |c| {
                    c.execute_batch("ANALYZE")?;
                    Ok(())
                })
                .await
                .unwrap();
            let settings = db.pool.settings(&Scope::default()).await.unwrap();
            assert_eq!(settings.len(), 3);
            for (index, settings) in settings.into_iter().enumerate() {
                assert_eq!(settings.journal_mode, "wal");
                assert_eq!(settings.synchronous, 1);
                assert_eq!(settings.busy_timeout, 5000);
                assert_eq!(settings.foreign_keys, 1);
                assert_eq!(settings.journal_size_limit, 67_108_864);
                assert_eq!(settings.wal_autocheckpoint, 1000);
                assert_eq!(settings.query_only, i64::from(index > 0));
            }
            assert!(db.rollups().await.unwrap().caught_up);
            let progress = db.rollups().await.unwrap();
            assert!(progress.caught_up && progress.verified);
            // Late rows: higher IDs with old timestamps land in old buckets and,
            // until the next run, in the raw edge (never both).
            let late: Vec<_> = (size + 1..=size + 3)
                .map(|id| RequestRecord {
                    id,
                    ts: now - 200 * 86_400_000,
                    status: 200,
                    endpoint: "/api/chat".into(),
                    model: Some("model".into()),
                    prompt_eval_count: Some(13),
                    ..Default::default()
                })
                .collect();
            db.import(late, vec![]).await.unwrap();
            db.pool
                .write(&Scope::default(), |c| {
                    c.execute_batch("ANALYZE")?;
                    Ok(())
                })
                .await
                .unwrap();
            let total = |value: &Value| -> u64 {
                value
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|r| r["requests"].as_u64().unwrap())
                    .sum()
            };
            let mut before_rollup = None;
            for (endpoint, budget, exception) in [
                ("/meter/health", 1, Some(ExceptionKind::LimitZero)),
                (
                    "/meter/requests?limit=3",
                    1,
                    Some(ExceptionKind::BoundedRowidWalk),
                ),
                ("/meter/requests?after_id=1&limit=3", 1, None),
                ("/meter/stats?range=24h", 3, None),
                ("/meter/stats?range=7d&model=model", 3, None),
                ("/meter/stats?range=30d", 3, None),
                ("/meter/stats?range=365d", 3, None),
                ("/meter/stats?range=365d&model=model", 3, None),
                ("/meter/gpu/history?range=7d", 1, None),
                ("/meter/gpu/history?range=30d", 2, None),
                ("/meter/openapi.json", 0, None),
            ] {
                let scope = Scope::recording();
                let mut scoped = db.clone();
                scoped.scope = Some(scope.clone());
                let (url, task) = serve(meter::router(AppState::new(
                    "http://127.0.0.1:1".into(),
                    scoped,
                )))
                .await;
                let value: Value = reqwest::get(format!("{url}{endpoint}"))
                    .await
                    .unwrap()
                    .error_for_status()
                    .unwrap()
                    .json()
                    .await
                    .unwrap();
                let counts = scope.counts();
                let schema = endpoint == "/meter/openapi.json";
                assert_eq!(counts.data, budget, "{endpoint}: {counts:?}");
                assert_eq!((counts.setup, counts.maintenance), (0, 0));
                assert_eq!(counts.transaction, if schema { 0 } else { 2 });
                if schema {
                    let path =
                        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("openapi.json");
                    if std::env::var_os("UPDATE_METER_OPENAPI").is_some() {
                        std::fs::write(&path, serde_json::to_string_pretty(&value).unwrap() + "\n")
                            .unwrap();
                    }
                    let golden: Value =
                        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
                    assert_eq!(value, golden);
                } else if endpoint.contains("stats") {
                    let total = total(&value);
                    assert!(total > 0);
                    assert_eq!(
                        value
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|r| r["input_tokens"].as_u64().unwrap())
                            .sum::<u64>(),
                        total * 13
                    );
                    let approximate = endpoint.contains("365d");
                    assert!(
                        value
                            .as_array()
                            .unwrap()
                            .iter()
                            .all(|r| r["percentiles_approximate"] == approximate)
                    );
                    if endpoint == "/meter/stats?range=365d" {
                        // Every row once: rolled history plus three unrolled late rows.
                        assert_eq!(total, size as u64 + 3);
                        before_rollup = Some(value.clone());
                    }
                } else if endpoint != "/meter/health" {
                    assert!(!value.as_array().unwrap().is_empty());
                }
                // Small fixtures can rationally scan. Require indexed plans on
                // the analyzed large fixture for every traced endpoint statement.
                if size > 3 && !schema {
                    let conn = rusqlite::Connection::open(&path).unwrap();
                    for sql in scope.statements() {
                        let mut required = Vec::new();
                        let tables: &[(&str, Option<&str>)] = if sql.contains("FROM request_hourly")
                        {
                            &[("request_hourly", None), ("request_daily", None)]
                        } else if sql.contains("FROM request_latency_hourly") {
                            &[
                                ("request_latency_hourly", None),
                                ("request_latency_daily", None),
                            ]
                        } else if sql.contains("INDEXED BY requests_ts_latency") {
                            &[("requests", Some("requests_ts_latency"))]
                        } else if sql.contains("FROM gpu_hourly") {
                            &[("gpu_hourly", None)]
                        } else if sql.contains("FROM gpu_samples") {
                            &[("gpu_samples", None)]
                        } else if sql.contains("FROM requests r") {
                            &[("r", None)]
                        } else {
                            &[]
                        };
                        if exception.is_none() {
                            required.extend(tables.iter().map(|(table, index)| RequiredSearch {
                                table,
                                index: *index,
                            }));
                        }
                        let count = conn.prepare(&sql).unwrap().parameter_count();
                        let mut params: Vec<rusqlite::types::Value> =
                            if sql.contains("LIMIT ?1") && sql.contains("id > ?2") {
                                vec![3.into(), 1.into()]
                            } else if sql.contains("LIMIT ?1") {
                                vec![3.into()]
                            } else if sql.contains("gpu_") {
                                // The production boundary: first whole hour of raw retention.
                                let boundary = now - 7 * 86_400_000;
                                let boundary = boundary - boundary % 3_600_000 + 3_600_000;
                                vec![(now - 30 * 86_400_000).into(), boundary.into()]
                            } else {
                                let since = now - 30 * 86_400_000 + 1;
                                let hour = since - since % 3_600_000 + 3_600_000;
                                vec![since.into(), hour.into()]
                            };
                        if count == 3 {
                            params.push("model".to_string().into());
                        }
                        if count == 2 && sql.contains("model=?2") {
                            params[1] = "model".to_string().into();
                        }
                        params.truncate(count);
                        let plan =
                            explain::query_plan(&conn, &sql, rusqlite::params_from_iter(params))
                                .unwrap();
                        let exceptions = exception
                            .map(|kind| Exception {
                                kind,
                                table: "requests",
                                reason: "metadata-only LIMIT 0 or bounded newest-ID walk",
                            })
                            .into_iter()
                            .collect::<Vec<_>>();
                        explain::validate(&plan, &required, &exceptions)
                            .unwrap_or_else(|e| panic!("{endpoint}: {sql}: {e}: {plan:?}"));
                    }
                }
                task.abort();
            }
            // Rolling the late rows up moves them from the raw edge into their
            // old buckets without changing any total.
            assert_eq!(db.rollups().await.unwrap().rows, 3);
            let (url, task) = serve(meter::router(AppState::new(
                "http://127.0.0.1:1".into(),
                db.clone(),
            )))
            .await;
            let after: Value = reqwest::get(format!("{url}/meter/stats?range=365d"))
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let before = before_rollup.unwrap();
            for (a, b) in after
                .as_array()
                .unwrap()
                .iter()
                .zip(before.as_array().unwrap())
            {
                for field in [
                    "model",
                    "requests",
                    "input_tokens",
                    "output_tokens",
                    "p50_total_latency_ms",
                    "p95_total_latency_ms",
                ] {
                    assert_eq!(a[field], b[field], "{field}");
                }
            }
            task.abort();
            db.close().await.unwrap();
        }
    })
    .await
    .expect("budget test timed out");
}
