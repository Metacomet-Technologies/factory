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
async fn slow_ndjson_is_incremental_and_written_once() {
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
    let db = Db::open(&directory.path().join("meter.db")).unwrap();
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
}

#[tokio::test]
async fn loopback_clients_use_machine_hostname() {
    let hostname = std::process::Command::new("hostname").output().unwrap();
    assert!(hostname.status.success());
    let hostname = String::from_utf8(hostname.stdout).unwrap();
    let (upstream, upstream_task) = serve(Router::new().fallback(|| async { "ok" })).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for (address, ip) in [("127.0.0.1:0", "127.0.0.1"), ("[::1]:0", "::1")] {
        let directory = tempfile::tempdir().unwrap();
        let db = Db::open(&directory.path().join("meter.db")).unwrap();
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
}

#[tokio::test]
async fn request_cursor_pages_without_gaps_and_preserves_legacy_behavior() {
    let directory = tempfile::tempdir().unwrap();
    let db = Db::open(&directory.path().join("meter.db")).unwrap();
    for index in 1..=1200 {
        db.send(Event::Request(Box::new(RequestRecord {
            ts: 1200 - index,
            endpoint: format!("/request/{index}"),
            ..Default::default()
        })));
    }
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
    db.send(Event::Request(Box::default()));
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
    task.abort();
}

#[tokio::test]
async fn arbitrary_endpoints_errors_openai_and_internal_contract() {
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
    let db = Db::open(&directory.path().join("meter.db")).unwrap();
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
    db.send(Event::Gpu(vec![expired, sample]));
    let history: Value = client
        .get(format!("{proxy}/meter/gpu/history?range=30d"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(history.as_array().unwrap().len(), 1);
    assert_eq!(history[0]["utilization_percent"], 37.0);
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
}

#[tokio::test]
async fn stats_quantiles_rates_and_model_filter() {
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
        Db::open(&directory.path().join("meter.db")).unwrap(),
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
}
