//! Remote device ingest through the HTTP API (docs/devices-ingest.md). Tokens are synthetic.
use factory_api::{AppState, device_auth, devices_ingest, fleet, now_ms, router};
use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, atomic::Ordering},
    time::Duration,
};

const COMPLETE: &str = include_str!("fixtures/devices-ingest/complete.json");
const UNSUPPORTED: &str = include_str!("fixtures/devices-ingest/unsupported.json");
const CONSOLE: &str = "fdv1_c0nsoleSyntheticToken0000000000000000000000";
const ROTATED: &str = "fdv1_r0tatedSyntheticToken0000000000000000000000";
const OTHER: &str = "fdv1_0therDeviceSyntheticToken000000000000000000";
const SESSION_A: &str = "6f1c2a9e-3b4d-4e8f-9a01-2c3d4e5f6a7b";
const SESSION_B: &str = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

fn hex(token: &str) -> String {
    device_auth::sha256(token)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn enroll(path: &Path, lines: &[(&str, &str)]) {
    let text: String = lines
        .iter()
        .map(|(device, token)| format!("{device} {} synthetic\n", hex(token)))
        .collect();
    let next = path.with_extension("new");
    std::fs::write(&next, text).unwrap();
    std::fs::rename(next, path).unwrap();
}

/// A fixture moved to `observed`: every `*_ms` timestamp shifts by the same amount.
fn sample(fixture: &str, session: &str, seq: i64, observed: i64) -> Value {
    fn shift(value: &mut Value, delta: i64) {
        match value {
            Value::Object(fields) => {
                for (key, field) in fields.iter_mut() {
                    if key.ends_with("_ms") && !key.ends_with("interval_ms") {
                        if let Some(at) = field.as_i64() {
                            *field = (at + delta).into();
                        }
                    } else {
                        shift(field, delta);
                    }
                }
            }
            Value::Array(items) => items.iter_mut().for_each(|item| shift(item, delta)),
            _ => {}
        }
    }
    let mut value: Value = serde_json::from_str(fixture).unwrap();
    let base = value["observed_at_ms"].as_i64().unwrap();
    shift(&mut value, observed - base);
    value["session_id"] = session.into();
    value["seq"] = seq.into();
    value
}

struct Api {
    url: String,
    client: Client,
    server: tokio::task::JoinHandle<()>,
}

async fn state(dir: &Path, tokens: &Path) -> AppState {
    let mut state = AppState::new(
        "http://127.0.0.1:1".into(),
        dir.join("requests.db"),
        dir.join("pricing.db"),
        fleet::Config { nodes: vec![] },
    )
    .await
    .unwrap();
    state.remote = Arc::new(devices_ingest::Registry::new(device_auth::Tokens::new(
        tokens,
    )));
    state.db.clock_synchronized.store(true, Ordering::Release);
    state
}

async fn serve(state: AppState) -> Api {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = router(state).into_make_service_with_connect_info::<std::net::SocketAddr>();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Api {
        url,
        client: Client::new(),
        server,
    }
}

impl Api {
    async fn post(&self, device: &str, token: Option<&str>, body: &Value) -> (StatusCode, Value) {
        let mut request = self
            .client
            .post(format!("{}/v1/devices/{device}/samples", self.url))
            .header("content-type", "application/json")
            .body(serde_json::to_vec(body).unwrap());
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let response = request.send().await.unwrap();
        let status = response.status();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    async fn get(&self, path: &str) -> (StatusCode, Value) {
        let response = self
            .client
            .get(format!("{}{path}", self.url))
            .send()
            .await
            .unwrap();
        let status = response.status();
        (status, response.json().await.unwrap())
    }
}

#[derive(Clone, Default)]
struct Log(Arc<Mutex<Vec<u8>>>);
impl Write for Log {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn setup() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    pricing::migrate(dir.path().join("pricing.db")).unwrap();
    let tokens = dir.path().join("device-tokens");
    (dir, tokens)
}

#[tokio::test]
async fn credentials_and_check_order() {
    let log = Log::default();
    let writer = log.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || writer.clone())
        .with_ansi(false)
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let (dir, tokens) = setup();
    let api = serve(state(dir.path(), &tokens).await).await;
    let now = now_ms();
    let body = sample(COMPLETE, SESSION_A, 1, now - 1_000);
    let mut bodies = Vec::new();

    // Missing file: every request is refused, with the Bearer challenge.
    let response = api
        .client
        .post(format!("{}/v1/devices/factory-console/samples", api.url))
        .bearer_auth(CONSOLE)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response.headers()["www-authenticate"], "Bearer");
    let refused: Value = response.json().await.unwrap();
    assert_eq!(refused["error"]["code"], "unauthorized");
    bodies.push(refused);

    enroll(
        &tokens,
        &[("factory-console", CONSOLE), ("factory-other", OTHER)],
    );

    // Method first: 405 names POST even without a credential.
    for method in [
        reqwest::Method::GET,
        reqwest::Method::PUT,
        reqwest::Method::DELETE,
    ] {
        let response = api
            .client
            .request(
                method,
                format!("{}/v1/devices/factory-console/samples", api.url),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(response.headers()["allow"], "POST");
    }
    // The read endpoints stay GET-only.
    let response = api
        .client
        .post(format!("{}/v1/devices/factory-console", api.url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.headers()["allow"], "GET");

    // Cross-site comes before the credential.
    let response = api
        .client
        .post(format!("{}/v1/devices/factory-console/samples", api.url))
        .header("sec-fetch-site", "cross-site")
        .bearer_auth(CONSOLE)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let value: Value = response.json().await.unwrap();
    assert_eq!(value["error"]["code"], "cross_site");

    // Unknown, malformed, query-string and spoofed identities are all 401.
    for token in [Some(ROTATED), Some("fdv1_short"), Some(&CONSOLE[1..]), None] {
        let (status, value) = api.post("factory-console", token, &body).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{token:?}");
        bodies.push(value);
    }
    let response = api
        .client
        .post(format!(
            "{}/v1/devices/factory-console/samples?token={CONSOLE}",
            api.url
        ))
        .header("Tailscale-User-Login", "DGarbs51@github")
        .header("Tailscale-App-Capabilities", r#"{"factory/devices":[{}]}"#)
        .header("X-Forwarded-For", "100.64.0.9")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    // A valid credential for another device, and factory-gpu always, are 403.
    let (status, value) = api.post("factory-other", Some(CONSOLE), &body).await;
    assert_eq!(
        (status, value["error"]["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("forbidden_device"))
    );
    let mut gpu = body.clone();
    gpu["device_id"] = "factory-gpu".into();
    let (status, _) = api.post("factory-gpu", Some(CONSOLE), &gpu).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = api.post("factory-gpu", None, &gpu).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Content type before size and JSON.
    let response = api
        .client
        .post(format!("{}/v1/devices/factory-console/samples", api.url))
        .bearer_auth(CONSOLE)
        .header("content-type", "text/plain")
        .body("{")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);

    // 64 KiB exactly is accepted; one more byte is 413.
    let mut padded = serde_json::to_vec(&body).unwrap();
    padded.resize(devices_ingest::MAX_BODY, b' ');
    for (bytes, expected) in [
        (padded.clone(), StatusCode::OK),
        ([padded, vec![b' ']].concat(), StatusCode::PAYLOAD_TOO_LARGE),
    ] {
        let response = api
            .client
            .post(format!("{}/v1/devices/factory-console/samples", api.url))
            .bearer_auth(CONSOLE)
            .header("content-type", "application/json; charset=utf-8")
            .body(bytes)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        bodies.push(response.json().await.unwrap());
    }

    // Exact error bodies.
    let mut version = body.clone();
    version["schema_version"] = 2.into();
    let (status, value) = api.post("factory-console", Some(CONSOLE), &version).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        value,
        json!({"error":{"code":"unsupported_schema_version","message":"schema_version 2 is not accepted","field":"schema_version"},"accepted_schema_versions":[1]})
    );
    let mut metric = sample(COMPLETE, SESSION_A, 2, now - 500);
    metric["cpu"]["utilization"]["value"] = 140.into();
    let (_, value) = api.post("factory-console", Some(CONSOLE), &metric).await;
    assert_eq!(
        value,
        json!({"error":{"code":"invalid_metric","message":"cpu.utilization: value 140 outside 0-100","field":"cpu.utilization"}})
    );
    let (status, value) = api.post("factory-other", Some(OTHER), &body).await;
    assert_eq!(
        (status, value["error"]["code"].as_str()),
        (StatusCode::BAD_REQUEST, Some("device_mismatch"))
    );

    // Rotation: two hashes for one device both work; revocation is immediate.
    enroll(
        &tokens,
        &[("factory-console", CONSOLE), ("factory-console", ROTATED)],
    );
    let (status, value) = api
        .post(
            "factory-console",
            Some(ROTATED),
            &sample(COMPLETE, SESSION_A, 2, now - 500),
        )
        .await;
    assert_eq!(
        (status, value["result"].as_str()),
        (StatusCode::OK, Some("stored"))
    );
    bodies.push(value);
    enroll(&tokens, &[("factory-console", ROTATED)]);
    let (status, _) = api
        .post(
            "factory-console",
            Some(CONSOLE),
            &sample(COMPLETE, SESSION_A, 3, now - 400),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Rate: 4/s with a burst of 8. Duplicates still count.
    let mut limited = None;
    for _ in 0..12 {
        let response = api
            .client
            .post(format!("{}/v1/devices/factory-console/samples", api.url))
            .bearer_auth(ROTATED)
            .json(&sample(COMPLETE, SESSION_A, 2, now - 500))
            .send()
            .await
            .unwrap();
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            limited = Some(response);
            break;
        }
    }
    let limited = limited.expect("burst over 8 is rate limited");
    assert!(
        limited.headers()["retry-after"]
            .to_str()
            .unwrap()
            .parse::<u64>()
            .unwrap()
            >= 1
    );
    let value: Value = limited.json().await.unwrap();
    assert_eq!(value["error"]["code"], "rate_limited");

    api.server.abort();
    let logs = String::from_utf8(log.0.lock().unwrap().clone()).unwrap();
    assert!(logs.contains("device ingest refused"));
    assert!(logs.contains("device=factory-console"));
    assert!(logs.contains("peer=127.0.0.1"));
    for secret in [CONSOLE, ROTATED, OTHER, &CONSOLE[5..], &hex(CONSOLE)] {
        assert!(!logs.contains(secret), "secret in logs");
        for body in &bodies {
            assert!(!body.to_string().contains(secret), "secret in a response");
        }
    }
}

#[tokio::test]
async fn ingest_semantics_history_and_restart() {
    let (dir, tokens) = setup();
    enroll(
        &tokens,
        &[("factory-console", CONSOLE), ("factory-other", OTHER)],
    );
    let first = state(dir.path(), &tokens).await;
    let api = serve(first.clone()).await;
    let now = now_ms();

    // Enrolled devices are listed beside factory-gpu and unknown until a fresh sample.
    let (_, list) = api.get("/v1/devices").await;
    let ids: Vec<&str> = list["devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["device_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["factory-gpu", "factory-console", "factory-other"]);
    assert_eq!(list["devices"][1]["health"], "unknown");
    assert_eq!(list["devices"][1]["href"], "/devices/factory-console");
    let (status, view) = api.get("/v1/devices/factory-console").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["device"]["health"]["status"], "unknown");
    assert_eq!(view["warnings"], json!(["waiting for first sample"]));
    assert_eq!(view["ingest"]["last_received_at_ms"], Value::Null);
    let (_, gpu) = api.get("/v1/devices/factory-gpu").await;
    assert_eq!(gpu["ingest"], Value::Null);
    let (status, _) = api.get("/v1/devices/not-enrolled").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = api.get("/v1/devices/not-enrolled/history").await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let mut stream = api
        .client
        .get(format!("{}/v1/stream", api.url))
        .send()
        .await
        .unwrap();
    // Paced under the 4/s device rate so every request reaches the ordering rules.
    let post = |body: Value| {
        let api = &api;
        async move {
            tokio::time::sleep(Duration::from_millis(260)).await;
            api.post("factory-console", Some(CONSOLE), &body).await
        }
    };

    // Drained backlog older than 45 s: history only, current stays unknown.
    let (_, value) = post(sample(COMPLETE, SESSION_A, 1, now - 300_000)).await;
    assert_eq!(
        (
            value["result"].as_str(),
            value["current_updated"].as_bool(),
            value["history_written"].as_bool()
        ),
        (Some("stored"), Some(false), Some(true))
    );
    let (_, view) = api.get("/v1/devices/factory-console").await;
    assert_eq!(view["device"]["health"]["status"], "unknown");

    let fresh = sample(COMPLETE, SESSION_A, 2, now - 2_000);
    let (status, value) = post(fresh.clone()).await;
    assert_eq!(status, StatusCode::OK);
    let keys: Vec<&String> = value.as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        [
            "current_updated",
            "device_id",
            "history_written",
            "observed_at_ms",
            "reason",
            "received_at_ms",
            "result",
            "seq",
            "session_id"
        ]
    );
    assert_eq!(value["reason"], Value::Null);
    assert_eq!(value["current_updated"], true);
    let received = value["received_at_ms"].as_i64().unwrap();
    assert!((now..=now_ms()).contains(&received));

    // The update reaches SSE as devices.sample for that device.
    let chunk = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let chunk = stream.chunk().await.unwrap().unwrap();
            let text = String::from_utf8(chunk.to_vec()).unwrap();
            if text.contains("event: devices.sample") {
                return text;
            }
        }
    })
    .await
    .unwrap();
    let event: Value = serde_json::from_str(
        chunk
            .lines()
            .find_map(|l| l.strip_prefix("data: "))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(event["data"]["device"]["device_id"], "factory-console");
    assert_eq!(event["data"]["ingest"]["seq"], 2);

    // Retry: duplicate. Older in the same session: out_of_order. Expired.
    let (_, value) = post(fresh.clone()).await;
    assert_eq!(
        (value["result"].as_str(), value["reason"].as_str()),
        (Some("ignored"), Some("duplicate"))
    );
    let (_, value) = post(sample(COMPLETE, SESSION_A, 3, now - 2_500)).await;
    assert_eq!(value["reason"], "out_of_order");
    let (_, value) = post(sample(COMPLETE, SESSION_A, 9, now - 7_300_000)).await;
    assert_eq!(value["reason"], "expired");

    // A seq gap counts as dropped; an agent restart (seq 1, new session) is accepted.
    let (_, value) = post(sample(COMPLETE, SESSION_A, 4, now - 1_500)).await;
    assert_eq!(value["result"], "stored");
    let (_, value) = post(sample(UNSUPPORTED, SESSION_B, 1, now - 1_000)).await;
    assert_eq!(value["result"], "stored");
    let (_, view) = api.get("/v1/devices/factory-console").await;
    assert_eq!(view["ingest"]["dropped_samples"], 1);
    assert_eq!(view["ingest"]["session_id"], SESSION_B);
    assert_eq!(view["ingest"]["seq"], 1);
    assert_eq!(view["ingest"]["agent_version"], "0.1.0");
    assert_eq!(view["ingest"]["identity_conflict"], false);
    assert!(view["ingest"]["clock_skew_ms"].as_i64().unwrap() <= 0);
    assert_eq!(view["device"]["health"]["status"], "healthy");
    assert_eq!(
        view["device"]["drives"][0]["smart"]["availability"],
        "unsupported"
    );
    assert_eq!(view["device"]["gpus"], json!([]));
    assert_eq!(
        view["device"]["maintenance"]["ups"]["availability"],
        "unsupported"
    );

    // Clock not synchronized on the device, then on the server: stored, no history.
    let mut unsynced = sample(COMPLETE, SESSION_B, 2, now - 800);
    unsynced["maintenance"]["clock"]["synchronized"] = false.into();
    let (_, value) = post(unsynced).await;
    assert_eq!(
        (value["history_written"].as_bool(), value["reason"].as_str()),
        (Some(false), Some("clock_unsynchronized"))
    );
    first.db.clock_synchronized.store(false, Ordering::Release);
    let (_, value) = post(sample(COMPLETE, SESSION_B, 3, now - 600)).await;
    assert_eq!(
        (
            value["current_updated"].as_bool(),
            value["history_written"].as_bool(),
            value["reason"].as_str()
        ),
        (Some(true), Some(false), Some("clock_unsynchronized"))
    );
    first.db.clock_synchronized.store(true, Ordering::Release);

    // Future skew beyond 60 s is rejected and changes nothing.
    let (status, value) = post(sample(COMPLETE, SESSION_B, 4, now_ms() + 61_000)).await;
    assert_eq!(
        (status, value["error"]["code"].as_str()),
        (StatusCode::BAD_REQUEST, Some("clock_skew"))
    );

    let last = sample(COMPLETE, SESSION_B, 4, now - 400);
    let (_, value) = post(last.clone()).await;
    assert_eq!(value["history_written"], true);

    // History: one row per stored, synchronized sample; no duplicates; no other device.
    let db = rusqlite::Connection::open(dir.path().join("requests.db")).unwrap();
    let rows: Vec<(String, i64)> = db
        .prepare("SELECT device_id, COUNT(*) FROM device_samples GROUP BY device_id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(rows, [("factory-console".to_string(), 5)]);
    let (_, history) = api
        .get("/v1/devices/factory-console/history?range=1h")
        .await;
    assert_eq!(history["device_id"], "factory-console");
    let counted: i64 = history["points"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["sample_count"].as_i64().unwrap())
        .sum();
    assert_eq!(counted, 5);
    let (_, other) = api.get("/v1/devices/factory-other/history?range=1h").await;
    assert_eq!(other["points"], json!([]));
    let (_, other) = api.get("/v1/devices/factory-other").await;
    assert_eq!(other["device"]["health"]["status"], "unknown");
    let (_, gpu) = api.get("/v1/devices/factory-gpu/history?range=1h").await;
    assert_eq!(gpu["points"], json!([]));
    let (status, _) = api
        .get("/v1/devices/factory-console/history?range=30d")
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    api.server.abort();
    first.db.close().await.unwrap();

    // Server restart: unknown until the next fresh sample; a retry stays out_of_order.
    let second = state(dir.path(), &tokens).await;
    let api = serve(second.clone()).await;
    let (_, view) = api.get("/v1/devices/factory-console").await;
    assert_eq!(view["device"]["health"]["status"], "unknown");
    let (_, value) = api.post("factory-console", Some(CONSOLE), &last).await;
    assert_eq!(value["reason"], "out_of_order");
    let (_, value) = api
        .post(
            "factory-console",
            Some(CONSOLE),
            &sample(COMPLETE, SESSION_B, 5, now_ms() - 100),
        )
        .await;
    assert_eq!(value["result"], "stored");
    let (_, view) = api.get("/v1/devices/factory-console").await;
    assert_eq!(view["device"]["health"]["status"], "healthy");
    let count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM device_samples WHERE device_id='factory-console'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 6);
    api.server.abort();
}

#[tokio::test]
async fn remote_views_go_stale_and_reads_keep_their_budgets() {
    let (dir, tokens) = setup();
    enroll(&tokens, &[("factory-console", CONSOLE)]);
    let state = state(dir.path(), &tokens).await;
    let now = now_ms();
    let body = serde_json::to_vec(&sample(COMPLETE, SESSION_A, 1, now - 1_000)).unwrap();
    let parsed = devices_ingest::parse(&body, "factory-console", now).unwrap();

    // First ingest after start reloads the last time once; later ones only write.
    let scope = factory_db::Scope::default();
    let mut scoped = state.clone();
    scoped.query_scope = scope.clone();
    scoped.ingest_sample(parsed.clone(), now).await.unwrap();
    let first = scope.counts().data;
    assert!(first <= 4, "first ingest used {first} statements");
    let scope = factory_db::Scope::default();
    scoped.query_scope = scope.clone();
    let mut next = parsed.clone();
    next.seq = 2;
    next.observed_at_ms += 500;
    next.host.observed_at_ms += 500;
    scoped.ingest_sample(next, now).await.unwrap();
    assert!(
        scope.counts().data <= 3,
        "later ingest used {} statements",
        scope.counts().data
    );

    // Reads: list and current from memory, history in one statement.
    for (path, budget) in [
        ("/v1/devices", 0),
        ("/v1/devices/factory-console", 0),
        ("/v1/devices/factory-console/history?range=24h", 1),
    ] {
        let scope = factory_db::Scope::default();
        let api = serve_scoped(state.clone(), scope.clone()).await;
        let (status, _) = api.get(path).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(scope.counts().data, budget, "{path}");
        api.server.abort();
    }

    // 45 s of silence makes the view stale; transport age is the reason.
    let view = state.remote.view("factory-console", now + 44_000).await;
    assert_eq!(
        view.device.health.status,
        factory_api::devices::HealthStatus::Healthy
    );
    let view = state.remote.view("factory-console", now + 46_000).await;
    assert_eq!(
        view.device.health.status,
        factory_api::devices::HealthStatus::Stale
    );
    assert!(
        view.device
            .health
            .reasons
            .iter()
            .any(|r| r.metric == "ingest.transport")
    );
    assert_eq!(view.device.cpu.utilization.value, None);
    assert_eq!(
        view.device.cpu.utilization.availability,
        factory_api::devices::Availability::Stale
    );
}

async fn serve_scoped(state: AppState, scope: factory_db::Scope) -> Api {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = router(state).layer(axum::Extension(scope));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Api {
        url,
        client: Client::new(),
        server,
    }
}
