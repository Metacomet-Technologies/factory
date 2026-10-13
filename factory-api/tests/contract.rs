use anyhow::{Context, Result};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use factory_api::{AppState, fleet, now_ms, router};
use serde_json::{Value, json};
use shared::RequestRecord;
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::RwLock;

async fn serve(app: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    (
        url,
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() }),
    )
}
fn keys(value: &Value, expected: &[&str]) {
    let mut actual: Vec<_> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    let mut expected = expected.to_vec();
    actual.sort();
    expected.sort();
    assert_eq!(actual, expected);
}
fn offline_refresh(
    store: &mut pricing::Store,
    references: &[pricing::Reference],
    at: i64,
) -> Result<Vec<pricing::Item>> {
    let models = [
        pricing::Model {
            model_id: "anthropic/claude-sonnet-5.5".into(),
            input_micro_usd_per_mtok: 3_000_000,
            output_micro_usd_per_mtok: 15_000_000,
            released_at_ms: Some(1),
        },
        pricing::Model {
            model_id: "openai/gpt-5.6-sol".into(),
            input_micro_usd_per_mtok: 2_000_000,
            output_micro_usd_per_mtok: 10_000_000,
            released_at_ms: Some(2),
        },
    ];
    store.refresh(references, &models, &models, at, vec![])
}
#[derive(Clone)]
struct Meter {
    records: Arc<RwLock<Vec<RequestRecord>>>,
    down: Arc<AtomicBool>,
    ts: i64,
}
async fn requests(
    State(meter): State<Meter>,
    Query(query): Query<BTreeMap<String, String>>,
) -> Result<Response, StatusCode> {
    assert_eq!(query.get("limit").map(String::as_str), Some("500"));
    if meter.down.load(Ordering::Relaxed) {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    let cursor: i64 = query["after_id"].parse().unwrap();
    let mut rows = meter.records.read().await.clone();
    rows.retain(|r| r.id > cursor);
    rows.sort_by_key(|r| r.id);
    rows.truncate(500);
    let next = rows.last().map(|r| r.id).unwrap_or(cursor);
    Ok(([("next_after_id", next.to_string())], Json(rows)).into_response())
}
async fn prices() -> Json<Value> {
    Json(json!({"data":[
        {"id":"anthropic/claude-sonnet-5.5", "created":1, "pricing":{"prompt":"0.000003","completion":"0.000015"}},
        {"id":"openai/gpt-5.6-sol", "created":2, "pricing":{"prompt":"0.000002","completion":"0.000010"}}
    ]}))
}
fn gpu_sample(ts: i64, index: u32) -> Value {
    json!({"index":index,"ts":ts,"memory_used_mib":321.0,"memory_total_mib":12288.0,"utilization_percent":27.0,"temperature_c":43.0,"power_w":48.5})
}
async fn gpu(State(meter): State<Meter>) -> Result<Json<Value>, StatusCode> {
    if meter.down.load(Ordering::Relaxed) {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    Ok(Json(
        json!({"gpus":[gpu_sample(meter.ts,0)], "ollama_ps":{"models":[{"name":"local:latest", "size":999999999999_u64}]}}),
    ))
}
async fn history(
    State(meter): State<Meter>,
    Query(query): Query<BTreeMap<String, String>>,
) -> Result<Json<Value>, StatusCode> {
    assert!(matches!(query["range"].as_str(), "24h" | "7d"));
    if meter.down.load(Ordering::Relaxed) {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    Ok(Json(json!([
        gpu_sample(meter.ts - 7_200_000, 0),
        gpu_sample(meter.ts - 1_000, 0),
        gpu_sample(meter.ts, 1)
    ])))
}
async fn fetch(client: &reqwest::Client, url: &str) -> Value {
    let response = client.get(url).send().await.unwrap();
    assert_eq!(response.status(), 200, "{url}");
    response.json().await.unwrap()
}

#[tokio::test]
async fn v1_contract_sync_ranges_events_and_outage() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let ts = now_ms();
    let record = |id, ts, prompt, duration| RequestRecord {
        id,
        ts,
        endpoint: "/api/generate".into(),
        model: Some("local:latest".into()),
        prompt_eval_count: prompt,
        eval_count: Some(4),
        prompt_eval_duration: duration,
        eval_duration: Some(if id == 2 {
            4_000_000_000
        } else {
            2_000_000_000
        }),
        load_duration: Some(3_000_000),
        total_duration: (id != 2).then_some(5_000_000_000),
        latency_ms: 9000.0,
        client_hostname: "client".into(),
        ..Default::default()
    };
    let meter = Meter {
        records: Arc::new(RwLock::new(vec![
            record(3, ts - 2 * 86_400_000, Some(100), Some(1_000_000_000)),
            record(2, ts - 100, None, None),
            record(1, ts - 1000, Some(23), Some(2_000_000_000)),
        ])),
        down: Default::default(),
        ts,
    };
    let (meter_url, meter_task) = serve(
        Router::new()
            .route("/meter/requests", get(requests))
            .route("/meter/gpu", get(gpu))
            .route("/meter/gpu/history", get(history))
            .route("/prices", get(prices))
            .route("/meter/health", get(|| async { Json(json!({"status":"ok", "version":"0.2.0", "git_sha":"a1b2c3d", "git_dirty":false, "built_at_ms":1_790_000_000_000_u64, "inputs_fingerprint":"012345abcdef"})) }))
            .route("/legacy-health", get(|| async { Json(json!({"status":"ok"})) }))
            .route("/v1/health", get(|| async { Json(shared::build_info(env!("FACTORY_INPUTS_FINGERPRINT"))) }))
            .route("/ok", get(|| async { StatusCode::NO_CONTENT }))
            .route("/redirect", get(|| async { StatusCode::FOUND }))
            .with_state(meter.clone()),
    )
    .await;
    let config = fleet::Config::parse(&format!(
        r#"
        [[nodes]]
        name="factory-gpu"
        services=[
          {{name="renamed-meter",kind="http",target="{meter_url}/meter/health"}},
          {{name="factory-api",kind="http",target="{meter_url}/v1/health"}},
          {{name="healthy",kind="http",target="{meter_url}/ok"}},
          {{name="redirect",kind="http",target="{meter_url}/redirect"}},
          {{name="tcp",kind="tcp",target="{}"}},
          {{name="missing-unit",kind="systemd",target="factory-api-test-does-not-exist.service"}}
        ]
        [[nodes]]
        name="absent-test-node"
        services=[{{name="meter-http",kind="http",target="{meter_url}/legacy-health"}}]
    "#,
        meter_url.trim_start_matches("http://")
    ))?;
    pricing::migrate(temp.path().join("pricing.db"))?;
    let mut state = AppState::new(
        meter_url,
        temp.path().join("requests.db"),
        temp.path().join("pricing.db"),
        config,
    )
    .await?;
    state.db.clock_synchronized.store(true, Ordering::Release);
    state.pricing_sources = [
        format!("{}/prices", state.meter_url),
        format!("{}/missing", state.meter_url),
    ];
    state.static_dir = temp.path().join("kiosk");
    state.usage_snapshot = temp.path().join("usage.json");
    let (url, api_task) = serve(router(state.clone())).await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?;
    let health = fetch(&client, &format!("{url}/v1/health")).await;
    keys(
        &health,
        &[
            "status",
            "version",
            "git_sha",
            "git_dirty",
            "built_at_ms",
            "inputs_fingerprint",
            "uptime_ms",
        ],
    );
    assert_eq!(health["status"], "ok");
    assert!(health["uptime_ms"].is_u64());
    assert_eq!(health["version"], include_str!("../../VERSION").trim());
    assert!(!health["git_sha"].as_str().unwrap().is_empty());
    assert!(health["git_dirty"].is_boolean());
    assert!(health["built_at_ms"].as_u64().unwrap() > 1_700_000_000_000);
    assert_eq!(
        health["inputs_fingerprint"],
        env!("FACTORY_INPUTS_FINGERPRINT")
    );

    let mut stream = client.get(format!("{url}/v1/stream")).send().await?;
    assert!(
        stream.headers()["content-type"]
            .to_str()?
            .starts_with("text/event-stream")
    );
    state.sync_meter().await?;
    let chunk = tokio::time::timeout(Duration::from_secs(2), stream.chunk())
        .await??
        .unwrap();
    let text = String::from_utf8(chunk.to_vec())?;
    assert!(text.contains("event: llm.request"));
    let event: Value =
        serde_json::from_str(text.lines().find_map(|l| l.strip_prefix("data: ")).unwrap())?;
    keys(&event, &["type", "ts_ms", "data"]);
    assert_eq!(event["type"], "llm.request");
    assert_eq!(
        event["data"],
        json!({"model":"local:latest","prompt_tokens":23,"output_tokens":4,"latency_ms":5000.0,"client_hostname":"client"})
    );
    state.sync_meter().await?; // Re-fetches upsert, never double-count.
    let usage = fetch(&client, &format!("{url}/v1/llm/usage?range=24h")).await;
    keys(
        &usage,
        &[
            "range",
            "generated_at_ms",
            "totals",
            "spend_avoided",
            "models",
            "warnings",
        ],
    );
    assert_eq!(
        usage["totals"],
        json!({"requests":2,"prompt_tokens":23,"output_tokens":8})
    );
    assert_eq!(
        usage["models"],
        json!([{"model":"local:latest","requests":2,"prompt_tokens":23,"output_tokens":8,"avg_prompt_tps":11.5,"avg_gen_tps":1.5,"p50_latency_ms":5000.0,"p95_latency_ms":9000.0,"total_load_ms":6.0}])
    );
    for spend in usage["spend_avoided"].as_array().unwrap() {
        keys(
            spend,
            &[
                "family",
                "model_id",
                "usd",
                "estimated_usd",
                "unpriced_requests",
            ],
        );
        assert_eq!(spend["unpriced_requests"], 2);
    }
    for range in ["7d", "30d"] {
        let usage = fetch(&client, &format!("{url}/v1/llm/usage?range={range}")).await;
        assert_eq!(usage["totals"]["requests"], 3);
    }
    let fleet = fetch(&client, &format!("{url}/v1/fleet")).await;
    keys(&fleet, &["generated_at_ms", "nodes"]);
    let nodes = fleet["nodes"].as_array().unwrap();
    assert_eq!(nodes.len(), 2);
    for node in nodes {
        keys(
            node,
            &[
                "name",
                "tailscale_ip",
                "online",
                "last_seen_ms",
                "os",
                "services",
            ],
        );
    }
    assert_eq!(nodes[1]["online"], false);
    assert_eq!(nodes[1]["last_seen_ms"], Value::Null);
    let services = nodes[0]["services"].as_array().unwrap();
    for service in services {
        keys(
            service,
            &[
                "name",
                "kind",
                "target",
                "ok",
                "latency_ms",
                "detail",
                "checked_at_ms",
                "version",
                "git_sha",
                "git_dirty",
                "built_at_ms",
                "inputs_fingerprint",
            ],
        );
    }
    assert_eq!(
        services
            .iter()
            .map(|s| s["ok"].as_bool().unwrap())
            .collect::<Vec<_>>(),
        vec![true, true, true, false, true, false]
    );
    assert_eq!(services[0]["version"], "0.2.0");
    assert_eq!(services[0]["git_sha"], "a1b2c3d");
    assert_eq!(services[0]["git_dirty"], false);
    assert_eq!(services[0]["built_at_ms"], 1_790_000_000_000_u64);
    assert_eq!(services[0]["inputs_fingerprint"], "012345abcdef");
    for key in [
        "version",
        "git_sha",
        "git_dirty",
        "built_at_ms",
        "inputs_fingerprint",
    ] {
        assert_eq!(services[1][key], health[key]);
        assert_eq!(services[2][key], Value::Null);
        assert_eq!(nodes[1]["services"][0][key], Value::Null);
    }
    assert_eq!(nodes[1]["services"][0]["ok"], true);
    let gpu = fetch(&client, &format!("{url}/v1/gpu")).await;
    keys(&gpu, &["current", "loaded_models", "history"]);
    assert_eq!(
        gpu["current"],
        json!({"ts_ms":ts,"memory_used_mib":321.0,"memory_total_mib":12288.0,"utilization_percent":27.0,"temperature_c":43.0,"power_w":48.5})
    );
    assert_eq!(gpu["loaded_models"], json!(["local:latest"]));
    assert_eq!(
        gpu["history"],
        json!([{"ts_ms":ts-1000,"memory_used_mib":321.0,"utilization_percent":27.0,"temperature_c":43.0,"power_w":48.5}])
    );
    for range in ["24h", "7d"] {
        assert_eq!(
            fetch(&client, &format!("{url}/v1/gpu?range={range}")).await["history"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
    let prices = fetch(&client, &format!("{url}/v1/pricing")).await;
    keys(&prices, &["families", "warnings"]);
    for family in prices["families"].as_array().unwrap() {
        keys(family, &["family", "selected", "rates", "pending"]);
        assert!(family["selected"].is_null() && family["pending"].is_null());
    }
    let prices: Value = client
        .post(format!("{url}/v1/pricing/refresh"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    for family in prices["families"].as_array().unwrap() {
        assert!(family["selected"].is_null());
        keys(&family["pending"], &["model_id", "effective_from_ms"]);
        assert!(family["pending"]["effective_from_ms"].as_i64().unwrap() >= ts - 1000);
    }
    let confirmed: Value = client
        .post(format!("{url}/v1/pricing/confirm/Claude%20Sonnet"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let sonnet = confirmed["families"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["family"] == "Claude Sonnet")
        .unwrap();
    assert!(sonnet["pending"].is_null());
    keys(&sonnet["selected"], &["model_id", "effective_from_ms"]);
    keys(
        &sonnet["rates"],
        &[
            "input_per_mtok",
            "output_per_mtok",
            "source",
            "fetched_at_ms",
        ],
    );
    assert_eq!(sonnet["rates"]["input_per_mtok"], 3.0);
    let agents = fetch(&client, &format!("{url}/v1/agents")).await;
    keys(&agents, &["tools"]);
    assert_eq!(
        agents["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| (&tool["tool"], &tool["status"]))
            .collect::<Vec<_>>(),
        vec![
            (&json!("amp"), &json!("unknown")),
            (&json!("cursor"), &json!("not_tracked")),
            (&json!("claude-code"), &json!("unknown")),
            (&json!("codex"), &json!("unknown")),
            (&json!("kimi"), &json!("not_tracked"))
        ]
    );
    let openapi = fetch(&client, &format!("{url}/openapi.json")).await;
    for path in [
        "/v1/health",
        "/v1/fleet",
        "/v1/llm/usage",
        "/v1/gpu",
        "/v1/pricing",
        "/v1/pricing/refresh",
        "/v1/pricing/confirm/{family}",
        "/v1/agents",
        "/v1/stream",
    ] {
        assert!(openapi["paths"][path].is_object(), "missing OpenAPI {path}");
    }
    // Resolve every schema reference: shared meter and API names must not collide.
    fn references(value: &Value, doc: &Value) {
        match value {
            Value::Object(map) => {
                for (key, value) in map {
                    if key == "$ref" {
                        assert!(
                            doc.pointer(value.as_str().unwrap().strip_prefix('#').unwrap())
                                .is_some(),
                            "unresolved {value}"
                        );
                    } else {
                        references(value, doc);
                    }
                }
            }
            Value::Array(items) => {
                for value in items {
                    references(value, doc);
                }
            }
            _ => (),
        }
    }
    references(&openapi, &openapi);
    for (path, method, status) in [
        ("/v1/gpu?range=30d", "GET", 400),
        ("/v1/llm/usage?range=1h", "GET", 400),
        ("/v1/gpu?range=1h&range=7d", "GET", 400),
        ("/missing", "GET", 404),
        ("/v1/health", "POST", 405),
        ("/v1/pricing/confirm/unknown", "POST", 404),
        (
            "/v1/pricing/confirm/Claude%20Sonnet&unexpected",
            "POST",
            404,
        ),
        ("/v1/pricing/confirm/Claude%20Sonnet/extra", "POST", 404),
        ("/v1/pricing/confirm/Claude%20Sonnet", "POST", 409),
    ] {
        let response = client
            .request(method.parse()?, format!("{url}{path}"))
            .send()
            .await?;
        assert_eq!(response.status().as_u16(), status);
        let value: Value = response.json().await?;
        keys(&value, &["error"]);
        keys(&value["error"], &["code", "message"]);
    }
    *meter.records.write().await = vec![record(8, ts, Some(31), Some(1_000_000_000))];
    state.sync_meter().await?;
    let usage = fetch(&client, &format!("{url}/v1/llm/usage")).await;
    assert_eq!(usage["totals"]["requests"], 3);
    assert!(
        usage["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w.as_str().unwrap().contains("gap: meter ids 4..7"))
    );
    meter.down.store(true, Ordering::Relaxed);
    assert!(state.sync_meter().await.is_err());
    let gpu = fetch(&client, &format!("{url}/v1/gpu")).await;
    assert_eq!(gpu, json!({"current":null,"loaded_models":[],"history":[]}));
    let usage = fetch(&client, &format!("{url}/v1/llm/usage")).await;
    assert_eq!(usage["totals"]["requests"], 3);
    assert!(
        usage["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w.as_str().unwrap().starts_with("meter:"))
    );
    // A feed outage returns the last pricing snapshot and warning, never auto-confirms.
    let mut failed = state.clone();
    failed.pricing_sources = [
        format!("{}/missing", state.meter_url),
        format!("{}/missing", state.meter_url),
    ];
    let (failed_url, failed_task) = serve(router(failed)).await;
    let failed_prices: Value = client
        .post(format!("{failed_url}/v1/pricing/refresh"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    assert!(
        failed_prices["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w
                .as_str()
                .unwrap()
                .contains("both pricing sources unavailable"))
    );
    drop(stream);
    failed_task.abort();
    api_task.abort();
    meter_task.abort();
    Ok(())
}

#[tokio::test]
async fn mixed_endpoints_only_count_and_stream_inference() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let at = now_ms().div_euclid(1000);
    let record = |id, endpoint: &str| RequestRecord {
        id,
        ts: (at - 30) * 1000,
        endpoint: endpoint.into(),
        model: Some("local:latest".into()),
        prompt_eval_count: Some(3),
        eval_count: Some(2),
        prompt_eval_duration: Some(1_000_000_000),
        eval_duration: Some(2_000_000_000),
        load_duration: Some(1_000_000),
        total_duration: Some(100_000_000),
        client_hostname: id.to_string(),
        ..Default::default()
    };
    let mut rows = vec![
        RequestRecord {
            model: None,
            prompt_eval_count: None,
            eval_count: None,
            ..record(1, "/api/version")
        },
        RequestRecord {
            prompt_eval_count: Some(900),
            eval_count: Some(800),
            ..record(2, "/api/tags")
        },
        RequestRecord {
            model: Some("excluded-model".into()),
            ..record(3, "/api/generate/extra")
        },
    ];
    // Keep the expected endpoint contract independent of the production constant.
    for (index, endpoint) in [
        "/api/generate",
        "/api/chat",
        "/api/embed",
        "/v1/chat/completions",
        "/v1/completions",
        "/v1/embeddings",
    ]
    .into_iter()
    .enumerate()
    {
        let mut row = record(index as i64 + 4, endpoint);
        if index < 2 {
            row.ts = (at - 180) * 1000;
        }
        if endpoint == "/api/embed" {
            row.eval_count = None;
        }
        rows.push(row);
    }
    rows.reverse(); // Meter returns newest IDs first.
    let meter = Meter {
        records: Arc::new(RwLock::new(rows)),
        down: Default::default(),
        ts: at * 1000,
    };
    let (meter_url, meter_task) = serve(
        Router::new()
            .route("/meter/requests", get(requests))
            .with_state(meter.clone()),
    )
    .await;
    let config = fleet::Config::parse("[[nodes]]\nname='factory-console'\nservices=[]")?;
    pricing::migrate(temp.path().join("pricing.db"))?;
    let state = AppState::new(
        meter_url,
        temp.path().join("requests.db"),
        temp.path().join("pricing.db"),
        config,
    )
    .await?;
    state.db.clock_synchronized.store(true, Ordering::Release);
    {
        let mut prices = pricing::Store::open(&state.pricing_db_path)?;
        offline_refresh(
            &mut prices,
            &pricing::parse_references(pricing::DEFAULT_CONFIG)?,
            (at - 120) * 1000,
        )?;
        prices.confirm("Claude Sonnet", (at - 60) * 1000)?;
    }
    let (url, api_task) = serve(router(state.clone())).await;
    let client = reqwest::Client::new();
    let mut stream = client.get(format!("{url}/v1/stream")).send().await?;
    state.sync_meter().await?;
    let events = tokio::time::timeout(Duration::from_secs(2), async {
        let mut pending = String::new();
        let mut events = Vec::<Value>::new();
        loop {
            let chunk = stream.chunk().await?.expect("open SSE stream");
            pending.push_str(std::str::from_utf8(&chunk)?);
            while let Some(end) = pending.find("\n\n") {
                let frame: String = pending.drain(..end + 2).collect();
                let json = frame
                    .lines()
                    .find_map(|line| line.strip_prefix("data: "))
                    .expect("SSE event data");
                events.push(serde_json::from_str(json)?);
            }
            if events
                .last()
                .is_some_and(|event| event["data"]["client_hostname"] == "9")
            {
                return Ok::<_, anyhow::Error>(events);
            }
        }
    })
    .await??;
    assert_eq!(events.len(), 6);
    for (index, event) in events.iter().enumerate() {
        assert_eq!(event["type"], "llm.request");
        assert_eq!(event["data"]["client_hostname"], (index + 4).to_string());
        assert_eq!(event["data"]["latency_ms"], 100.0);
    }
    let usage = fetch(&client, &format!("{url}/v1/llm/usage")).await;
    assert_eq!(
        usage["totals"],
        json!({"requests":6,"prompt_tokens":18,"output_tokens":10})
    );
    assert_eq!(
        usage["models"],
        json!([{"model":"local:latest","requests":6,"prompt_tokens":18,"output_tokens":10,"avg_prompt_tps":3.0,"avg_gen_tps":1.0,"p50_latency_ms":100.0,"p95_latency_ms":100.0,"total_load_ms":6.0}])
    );
    let spend = usage["spend_avoided"].as_array().unwrap();
    let sonnet = spend
        .iter()
        .find(|s| s["family"] == "Claude Sonnet")
        .unwrap();
    assert!((sonnet["usd"].as_f64().unwrap() - 0.000117).abs() < 1e-12);
    assert!((sonnet["estimated_usd"].as_f64().unwrap() - 0.000078).abs() < 1e-12);
    assert_eq!(sonnet["unpriced_requests"], 1);
    let sol = spend
        .iter()
        .find(|s| s["family"] == "ChatGPT mid-tier")
        .unwrap();
    assert_eq!(sol["unpriced_requests"], 6);
    assert_eq!(sol["usd"], 0.0);
    assert_eq!(sol["estimated_usd"], 0.0);

    *meter.records.write().await = vec![record(10, "/api/version")];
    state.sync_meter().await?;
    assert!(
        tokio::time::timeout(Duration::from_millis(100), stream.chunk())
            .await
            .is_err()
    );
    *meter.records.write().await = vec![record(11, "/api/chat")];
    state.sync_meter().await?;
    let usage = fetch(&client, &format!("{url}/v1/llm/usage")).await;
    assert_eq!(usage["totals"]["requests"], 7);
    assert_eq!(usage["warnings"], json!([])); // Non-inference IDs still advance the watermark.
    drop(stream);
    api_task.abort();
    meter_task.abort();
    Ok(())
}

#[test]
fn tailscale_units_and_local_only_config() -> Result<()> {
    let config = fleet::Config::parse(fleet::DEFAULT_CONFIG)?;
    let status = json!({"Self":{"HostName":"factory-console","TailscaleIPs":["100.1.2.3"],"Online":true,"OS":"linux","LastSeen":"2026-10-11T01:10:40.123-04:00"},"Peer":{}});
    let node = fleet::node(&config.nodes[1], &status);
    assert_eq!(node.last_seen_ms, Some(1_791_695_440_123));
    assert_eq!(node.tailscale_ip.as_deref(), Some("100.1.2.3"));
    assert!(node.online);
    assert!(fleet::Config::parse("[[nodes]]\nname='factory-console'\nservices=[{name='remote',kind='systemd',target='amp-runner'}]").is_err());
    assert!(fleet::Config::parse("[[nodes]]\nname='factory-gpu'\nservices=[{name='local',kind='systemd',target='amp-runner'}]").is_ok());
    Ok(())
}

#[tokio::test]
async fn runtime_kiosk_serving_and_api_isolation() -> Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let temp = tempfile::tempdir()?;
    let root = temp.path().join("kiosk");
    pricing::migrate(temp.path().join("pricing.db"))?;
    let mut state = AppState::new(
        "http://127.0.0.1:1".into(),
        temp.path().join("requests.db"),
        temp.path().join("pricing.db"),
        fleet::Config::parse(fleet::DEFAULT_CONFIG)?,
    )
    .await?;
    state.static_dir = root.clone();
    state.db.clock_synchronized.store(true, Ordering::Release);
    let (url, task) = serve(router(state)).await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()?;

    // Absence and an empty directory both keep the browser on a 200 HTML page.
    for empty_directory in [false, true] {
        if empty_directory {
            std::fs::create_dir(&root)?;
        }
        let response = client.get(format!("{url}/")).send().await?;
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers()["content-type"],
            "text/html; charset=utf-8"
        );
        assert_eq!(response.headers()["cache-control"], "no-cache");
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        let page = response.text().await?;
        assert!(page.contains("factory · kiosk not deployed yet"));
        assert!(page.contains("name=\"color-scheme\" content=\"light dark\""));
        assert!(page.contains("--background:light-dark(#f6f6f7,#131315)"));
        assert!(page.contains("html,body{background:var(--background)"));
        assert!(page.contains("http-equiv=\"refresh\" content=\"30\""));
        assert!(page.contains("setInterval(() => location.reload(), 30000)"));
        assert!(page.contains("document.addEventListener(\"visibilitychange\""));
        assert!(page.contains("if (document.visibilityState === \"visible\") location.reload()"));
        assert_eq!(
            fetch(&client, &format!("{url}/v1/health")).await["status"],
            "ok"
        );
    }

    let index = "<!doctype html><html><title>test kiosk</title><body>deployed</body></html>";
    std::fs::write(root.join("index.html"), index)?;
    std::fs::create_dir(root.join("assets"))?;
    std::fs::write(root.join("assets/x-a1b2c3d4.js"), "console.log('kiosk');")?;
    std::fs::write(root.join("assets/theme-a1b2c3d4.css"), "body{color:red}")?;
    std::fs::create_dir(root.join("v1"))?;
    for path in ["v1/health", "v1/stream", "v1/unknown", "openapi.json"] {
        std::fs::write(root.join(path), "must never be served")?;
    }
    for path in ["/", "/index.html", "/some/deep/route"] {
        let response = client
            .get(format!("{url}{path}"))
            .header("accept", "application/json, text/html;q=0.8")
            .send()
            .await?;
        assert_eq!(response.status(), 200, "{path}");
        assert_eq!(response.headers()["cache-control"], "no-cache");
        assert_eq!(response.text().await?, index);
    }
    for (path, mime, body) in [
        (
            "/assets/x-a1b2c3d4.js",
            "text/javascript; charset=utf-8",
            "console.log('kiosk');",
        ),
        (
            "/assets/theme-a1b2c3d4.css",
            "text/css; charset=utf-8",
            "body{color:red}",
        ),
    ] {
        let response = client.get(format!("{url}{path}")).send().await?;
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["content-type"], mime);
        assert_eq!(
            response.headers()["cache-control"],
            "public, max-age=31536000, immutable"
        );
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert_eq!(response.text().await?, body);
    }
    for (path, accept) in [
        ("/some/deep/route", "application/json"),
        ("/some/deep/route", "text/html;q=0"),
        ("/assets/", "*/*"),
    ] {
        assert_eq!(
            client
                .get(format!("{url}{path}"))
                .header("accept", accept)
                .send()
                .await?
                .status(),
            404
        );
    }
    let head = client.head(format!("{url}/")).send().await?;
    assert_eq!(head.status(), 200);
    assert_eq!(head.headers()["content-length"], index.len().to_string());
    assert!(head.bytes().await?.is_empty());
    assert_eq!(
        client
            .post(format!("{url}/some/deep/route"))
            .header("accept", "text/html")
            .send()
            .await?
            .status(),
        405
    );
    assert_eq!(
        fetch(&client, &format!("{url}/v1/health")).await["status"],
        "ok"
    );
    assert_eq!(
        fetch(&client, &format!("{url}/openapi.json")).await["openapi"],
        "3.1.0"
    );
    for path in ["/v1", "/v1/unknown", "/%76%31/unknown", "/%6fpenapi.json"] {
        let unknown = client
            .get(format!("{url}{path}"))
            .header("accept", "text/html")
            .send()
            .await?;
        assert_eq!(unknown.status(), 404, "{path}");
        assert_eq!(unknown.json::<Value>().await?["error"]["code"], "not_found");
    }
    let stream = client
        .get(format!("{url}/v1/stream"))
        .header("accept", "text/html")
        .send()
        .await?;
    assert_eq!(stream.status(), 200);
    assert_eq!(stream.headers()["content-type"], "text/event-stream");
    drop(stream);

    std::fs::write(temp.path().join("secret.txt"), "outside kiosk")?;
    std::os::unix::fs::symlink(temp.path().join("secret.txt"), root.join("leak.txt"))?;
    assert_eq!(
        client
            .get(format!("{url}/leak.txt"))
            .header("accept", "text/html")
            .send()
            .await?
            .status(),
        403
    );
    // Raw HTTP avoids client URL normalization hiding literal or encoded traversal.
    for path in [
        "/../secret.txt",
        "/%2e%2e/secret.txt",
        "/assets/%2E%2E/%2e%2e/secret.txt",
        "/%2e%2e%2fsecret.txt",
        "/..%5csecret.txt",
        "/%2fetc/passwd",
        "/%00secret.txt",
    ] {
        let mut socket =
            tokio::net::TcpStream::connect(url.strip_prefix("http://").unwrap()).await?;
        socket.write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nAccept: text/html\r\nConnection: close\r\n\r\n").as_bytes()).await?;
        let mut response = String::new();
        socket.read_to_string(&mut response).await?;
        assert!(response.starts_with("HTTP/1.1 400"), "{path}: {response}");
        assert!(!response.contains("outside kiosk"));
    }
    // Files are read at request time, not captured when the router is built.
    std::fs::write(root.join("index.html"), "updated kiosk")?;
    assert_eq!(
        client.get(format!("{url}/")).send().await?.text().await?,
        "updated kiosk"
    );
    task.abort();
    Ok(())
}

async fn test_state(temp: &tempfile::TempDir, meter_url: String) -> Result<AppState> {
    pricing::migrate(temp.path().join("pricing.db"))?;
    let state = AppState::new(
        meter_url,
        temp.path().join("requests.db"),
        temp.path().join("pricing.db"),
        fleet::Config::parse("[[nodes]]\nname='factory-console'\nservices=[]")?,
    )
    .await?;
    state.db.clock_synchronized.store(true, Ordering::Release);
    Ok(state)
}

#[tokio::test]
async fn sixty_second_pricing_source_and_sqlite_writer_do_not_stall_reads() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let entered = Arc::new(tokio::sync::Semaphore::new(0));
    let notify = entered.clone();
    let (feed, feed_task) = serve(Router::new().route(
        "/",
        get(move || {
            let notify = notify.clone();
            async move {
                notify.add_permits(1);
                tokio::time::sleep(Duration::from_secs(60)).await;
                StatusCode::SERVICE_UNAVAILABLE
            }
        }),
    ))
    .await;
    let mut state = test_state(&temp, feed.clone()).await?;
    state.pricing_sources = [feed.clone(), feed];
    let refresh_state = state.clone();
    let refresh = tokio::spawn(async move { refresh_state.refresh_pricing().await });
    tokio::time::timeout(Duration::from_secs(2), entered.acquire_many(2))
        .await??
        .forget();
    let (url, api_task) = serve(router(state.clone())).await;
    let client = reqwest::Client::new();
    // Hold real SQLite write transactions, not a mocked lock. WAL readers must
    // still see the previous committed state on a single-thread Tokio runtime.
    let requests = rusqlite::Connection::open(&state.db_path)?;
    let prices = rusqlite::Connection::open(&state.pricing_db_path)?;
    requests.execute_batch("BEGIN IMMEDIATE")?;
    prices.execute_batch("BEGIN IMMEDIATE")?;
    let write_state = state.clone();
    let started = std::time::Instant::now();
    let write = tokio::spawn(async move {
        write_state
            .db
            .write(&write_state.query_scope, |db| {
                factory_api::data::sync(
                    db,
                    vec![RequestRecord {
                        id: 1,
                        ts: now_ms(),
                        endpoint: "/api/chat".into(),
                        ..Default::default()
                    }],
                )
            })
            .await
    });
    tokio::task::yield_now().await;
    // An inline SQLite busy wait would block this single Tokio worker for 1s.
    assert!(started.elapsed() < Duration::from_millis(200));
    for path in ["/v1/llm/usage?range=30d", "/v1/pricing", "/v1/health"] {
        let start = std::time::Instant::now();
        let value = tokio::time::timeout(
            Duration::from_millis(200),
            fetch(&client, &format!("{url}{path}")),
        )
        .await?;
        assert!(start.elapsed() < Duration::from_millis(200));
        assert!(value.is_object());
        eprintln!("stalled source + WAL writer: {path}: {:?}", start.elapsed());
    }
    assert!(
        !refresh.is_finished(),
        "the refresh must still be awaiting the source"
    );
    requests.execute_batch("ROLLBACK")?;
    prices.execute_batch("ROLLBACK")?;
    assert_eq!(write.await??.len(), 1);
    assert_eq!(state.usage("30d".into(), 0).await?.totals.requests, 1);
    refresh.abort();
    let _ = refresh.await;
    state.db.close().await?;
    api_task.abort();
    feed_task.abort();
    Ok(())
}

#[tokio::test]
async fn cursor_sync_recovers_multiple_pages_and_restarts_without_false_gaps() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let meter = Meter {
        records: Arc::new(RwLock::new(
            (1..=1207)
                .map(|id| RequestRecord {
                    id,
                    ts: now_ms(),
                    endpoint: "/api/chat".into(),
                    ..Default::default()
                })
                .collect(),
        )),
        down: Default::default(),
        ts: now_ms(),
    };
    let (url, task) = serve(
        Router::new()
            .route("/meter/requests", get(requests))
            .with_state(meter.clone()),
    )
    .await;
    let state = test_state(&temp, url.clone()).await?;
    state.sync_meter().await?;
    let usage = state.usage("30d".into(), 0).await?;
    assert_eq!(usage.totals.requests, 1207);
    assert!(usage.warnings.is_empty());
    state.db.close().await?;
    drop(state);
    let state = test_state(&temp, url).await?;
    // Only IDs after the durable cursor remain available in this fixture.
    *meter.records.write().await = (1208..=1210)
        .map(|id| RequestRecord {
            id,
            ts: now_ms(),
            endpoint: "/api/chat".into(),
            ..Default::default()
        })
        .collect();
    state.sync_meter().await?;
    state.sync_meter().await?;
    let usage = state.usage("30d".into(), 0).await?;
    assert_eq!(usage.totals.requests, 1210);
    assert!(usage.warnings.is_empty());
    // A hole within a page, not just at its start, is a real discontinuity.
    *meter.records.write().await = [1211, 1214]
        .map(|id| RequestRecord {
            id,
            ts: now_ms(),
            endpoint: "/api/chat".into(),
            ..Default::default()
        })
        .to_vec();
    state.sync_meter().await?;
    let usage = state.usage("30d".into(), 0).await?;
    assert_eq!(usage.totals.requests, 1212);
    assert_eq!(usage.warnings.len(), 1);
    assert!(usage.warnings[0].contains("1212..1213"));
    state.db.close().await?;
    task.abort();
    Ok(())
}

/// Worst successful views: both families have selected and pending rates.
#[tokio::test]
async fn measured_endpoint_budgets_and_all_connection_settings() -> Result<()> {
    tokio::time::timeout(Duration::from_secs(30), async {
    const USAGE: usize = 16;
    const PRICING: usize = 9;
    const CONFIRM: usize = 29;
    const NO_DATABASE: usize = 0;
    const REQUESTS_SETUP: usize = 72;
    const PRICING_SETUP: usize = 74;
    for n in [3usize, 1001] {
        let temp = tempfile::tempdir()?;
        let at = now_ms();
        let meter = Meter {
            records: Arc::new(RwLock::new(
                (1..=n)
                    .map(|i| RequestRecord {
                        id: (i * 2) as i64,
                        ts: at - 1000,
                        endpoint: "/api/chat".into(),
                        model: (i % 3 != 0).then(|| "local".into()),
                        prompt_eval_count: Some(3),
                        eval_count: Some(7),
                        ..Default::default()
                    })
                    .collect(),
            )),
            down: Default::default(),
            ts: at,
        };
        let (upstream, upstream_task) = serve(
            Router::new()
                .route("/meter/requests", get(requests))
                .route("/meter/gpu", get(gpu))
                .route("/meter/gpu/history", get(history))
                .with_state(meter),
        )
        .await;
        let mut state = test_state(&temp, upstream).await?;
        state.static_dir = temp.path().join("kiosk");
        std::fs::create_dir(&state.static_dir)?;
        std::fs::write(state.static_dir.join("index.html"), "fixture".repeat(n))?;
        state.db.write_pricing(&factory_db::Scope::default(), move |store| {
            let references = pricing::parse_references(pricing::DEFAULT_CONFIG)?;
            let start = at - 10_000_000;
            offline_refresh(store, &references, start)?;
            store.confirm("Claude Sonnet", start)?;
            store.confirm("ChatGPT mid-tier", start)?;
            // Asymmetric histories for the two families, with both source ties.
            for i in 1..=if n == 3 { 4 } else { 31 } {
                offline_refresh(store, &references, start + i)?;
                if i % 3 == 0 {
                    store.connection().execute("INSERT INTO reference_selection(family,model_id,effective_from_ms,confirmed,refresh_id) VALUES ('Claude Sonnet','anthropic/claude-sonnet-5.5',?1,1,1)", [start + i])?;
                }
            }
            store.refresh(&references, &[
                pricing::Model { model_id: "anthropic/claude-sonnet-6".into(), input_micro_usd_per_mtok: 9_000_000, output_micro_usd_per_mtok: 21_000_000, released_at_ms: Some(3) },
                pricing::Model { model_id: "openai/gpt-6-sol".into(), input_micro_usd_per_mtok: 5_000_000, output_micro_usd_per_mtok: 11_000_000, released_at_ms: Some(4) },
            ], &[], at - 2000, vec![])?;
            Ok(())
        }).await?;
        let sync = factory_db::Scope::default();
        state.query_scope = sync.clone();
        state.sync_meter().await?;
        let page_counts: Vec<_> = (0..n)
            .step_by(500)
            .map(|offset| 1 + 2 * (n - offset).min(500).div_ceil(100))
            .collect();
        assert_eq!(sync.counts().data, 1 + page_counts.iter().sum::<usize>());
        assert_eq!(sync.counts().setup, 0);
        eprintln!(
            "sync n={n}: data={}, page jobs={page_counts:?}, initial cursor=1",
            sync.counts().data
        );
        let settings_scope = factory_db::Scope::default();
        for (name, settings) in [
            (
                "requests",
                state
                    .db
                    .requests
                    .settings(&settings_scope)
                    .await?,
            ),
            (
                "pricing",
                state
                    .db
                    .pricing
                    .settings(&settings_scope)
                    .await?,
            ),
        ] {
            assert_eq!(settings.len(), 3);
            for (index, actual) in settings.iter().enumerate() {
                assert_eq!(actual.journal_mode, "wal");
                assert_eq!(
                    (
                        actual.synchronous,
                        actual.busy_timeout,
                        actual.foreign_keys,
                        actual.journal_size_limit
                    ),
                    (1, 5000, 1, 67108864)
                );
                assert_eq!(actual.query_only, i64::from(index > 0));
                if index > 0 {
                    assert_eq!(actual.cache_size, -65536);
                }
                assert_eq!(actual.wal_autocheckpoint, 1000);
            }
            eprintln!("{name} settings: {settings:?}");
        }
        // Eight PRAGMAs on each of six connections; a lost trace hook reduces this total.
        assert_eq!(settings_scope.counts(), factory_db::counter::Counts { setup: 48, ..Default::default() });
        eprintln!(
            "startup requests={:?}, pricing={:?}",
            state.db.requests.startup.counts(),
            state.db.pricing.startup.counts()
        );
        assert_eq!(state.db.requests.startup.counts().setup, REQUESTS_SETUP);
        assert_eq!(state.db.pricing.startup.counts().setup, PRICING_SETUP);
        assert_eq!(state.db.requests.startup.counts().maintenance, 1);
        assert_eq!(state.db.pricing.startup.counts().maintenance, 1);
        let client = reqwest::Client::new();
        for (path, budget) in [
            ("/v1/llm/usage?range=24h", USAGE),
            ("/v1/llm/usage?range=7d", USAGE),
            ("/v1/llm/usage?range=30d", USAGE),
            ("/v1/pricing", PRICING),
            ("/v1/health", NO_DATABASE),
            ("/v1/fleet", NO_DATABASE),
            ("/v1/agents", NO_DATABASE),
            ("/v1/gpu", NO_DATABASE),
            ("/v1/stream", NO_DATABASE),
            ("/", NO_DATABASE),
            ("/openapi.json", NO_DATABASE),
            ("/v1/pricing/confirm/Claude%20Sonnet", CONFIRM),
        ] {
            let scope = factory_db::Scope::default();
            let (url, task) =
                serve(router(state.clone()).layer(axum::Extension(scope.clone()))).await;
            let request = if path.contains("/confirm/") {
                client.post(format!("{url}{path}"))
            } else {
                client.get(format!("{url}{path}"))
            };
            let response = request.send().await?;
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            if path != "/v1/stream" {
                let body = response.bytes().await?;
                assert!(!body.is_empty());
                if path.contains("usage") {
                    let value: Value = serde_json::from_slice(&body)?;
                    assert_eq!(value["totals"]["requests"], n);
                    assert_eq!(value["totals"]["prompt_tokens"], 3 * n);
                    assert_eq!(value["models"].as_array().unwrap().len(), 2);
                    let costs = value["spend_avoided"].as_array().unwrap();
                    for (family, per_request) in
                        [("Claude Sonnet", 0.000114), ("ChatGPT mid-tier", 0.000076)]
                    {
                        let cost = costs.iter().find(|s| s["family"] == family).unwrap();
                        assert!(
                            (cost["usd"].as_f64().unwrap() - per_request * n as f64).abs() < 1e-9
                        );
                        assert_eq!(cost["unpriced_requests"], 0);
                    }
                } else if path.contains("confirm") {
                    let value: Value = serde_json::from_slice(&body)?;
                    assert_eq!(
                        value["families"][0]["selected"]["model_id"],
                        "anthropic/claude-sonnet-6"
                    );
                }
            }
            assert_eq!(scope.counts().data, budget, "n={n} {path}");
            assert_eq!((scope.counts().setup, scope.counts().maintenance), (0, 0));
            eprintln!("n={n} {path}: {:?}", scope.counts());
            task.abort();
        }
        let mut primary = Vec::new();
        let mut secondary = serde_json::Map::new();
        for i in 0..n {
            let (id, provider) = match i {
                0 => ("claude-sonnet-7".to_owned(), "anthropic"),
                1 => ("gpt-7-sol".to_owned(), "openai"),
                _ => (format!("gpt-noise-{i}"), "openai"),
            };
            primary.push(json!({"id":format!("{provider}/{id}"),"created":10,"pricing":{"prompt":"0.000002","completion":"0.000008"}}));
            secondary.insert(id, json!({"litellm_provider":provider,"input_cost_per_token":0.000002,"output_cost_per_token":0.000008}));
        }
        let primary = json!({"data":primary});
        let secondary = Value::Object(secondary);
        let (feed, feed_task) = serve(
            Router::new()
                .route(
                    "/primary",
                    get(move || {
                        let body = primary.clone();
                        async move { Json(body) }
                    }),
                )
                .route(
                    "/secondary",
                    get(move || {
                        let body = secondary.clone();
                        async move { Json(body) }
                    }),
                ),
        )
        .await;
        state.pricing_sources = [format!("{feed}/primary"), format!("{feed}/secondary")];
        let scope = factory_db::Scope::default();
        let (url, task) = serve(router(state.clone()).layer(axum::Extension(scope.clone()))).await;
        let response = client
            .post(format!("{url}/v1/pricing/refresh"))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        assert_eq!(
            response["families"][0]["pending"]["model_id"],
            "anthropic/claude-sonnet-7"
        );
        assert_eq!(
            response["families"][1]["pending"]["model_id"],
            "openai/gpt-7-sol"
        );
        let warnings = response["warnings"].as_array().unwrap();
        assert_eq!(warnings.len(), 2);
        assert!(
            warnings
                .iter()
                .all(|w| w.as_str().unwrap().contains("cross-check unavailable"))
        );
        // Two views (8 before / 9 after), six fixed job statements, then batches.
        assert_eq!(scope.counts().data, 17 + 6 + (2 * n).div_ceil(100) + 1 + 1);
        assert_eq!(scope.counts().transaction, 6);
        assert_eq!((scope.counts().setup, scope.counts().maintenance), (0, 0));
        eprintln!("n={n} /v1/pricing/refresh: {:?}", scope.counts());
        task.abort();
        feed_task.abort();
        state.query_scope = factory_db::Scope::default();
        assert!(state.gpu_current().await.0.is_some());
        assert_eq!(state.query_scope.counts().data, NO_DATABASE);
        state.db.close().await?;
        upstream_task.abort();
    }
    Ok(())
    })
    .await
    .context("measured_endpoint_budgets_and_all_connection_settings exceeded 30 seconds")?
}

#[test]
fn repo_versions_match_single_source() -> Result<()> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let version = std::fs::read_to_string(root.join("VERSION"))?;
    let version = version.trim();
    let workspace: toml::Value =
        toml::from_str(&std::fs::read_to_string(root.join("Cargo.toml"))?)?;
    assert_eq!(
        workspace["workspace"]["package"]["version"].as_str(),
        Some(version)
    );
    for member in workspace["workspace"]["members"].as_array().unwrap() {
        let manifest: toml::Value = toml::from_str(&std::fs::read_to_string(
            root.join(member.as_str().unwrap()).join("Cargo.toml"),
        )?)?;
        assert_eq!(
            manifest["package"]["version"]["workspace"].as_bool(),
            Some(true)
        );
    }
    let kiosk: Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("kiosk/package.json"))?)?;
    assert_eq!(kiosk["version"], version);
    Ok(())
}

#[tokio::test]
async fn unsynchronized_clock_pauses_feeds_and_all_data_writes_until_recovery() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = calls.clone();
    let (feed, task) = serve(Router::new().route(
        "/",
        get(move || {
            count.fetch_add(1, Ordering::Relaxed);
            prices()
        }),
    ))
    .await;
    let mut state = test_state(&temp, feed.clone()).await?;
    state.pricing_sources = [feed.clone(), feed];
    state.db.clock_synchronized.store(false, Ordering::Release);
    assert!(state.sync_meter().await.is_err());
    assert!(state.confirm_pricing("Claude Sonnet".into()).await.is_err());
    assert!(
        state
            .db
            .write(&state.query_scope, |db| {
                db.execute("INSERT INTO warnings VALUES ('bad clock')", [])?;
                Ok(())
            })
            .await
            .is_err()
    );
    let snapshot = state.refresh_pricing().await?;
    assert!(snapshot.warnings.iter().any(|w| w.starts_with("clock:")));
    assert!(snapshot.families.iter().all(|f| f.pending.is_none()));
    assert_eq!(calls.load(Ordering::Relaxed), 0);
    state.db.clock_synchronized.store(true, Ordering::Release);
    let snapshot = state.refresh_pricing().await?;
    assert!(snapshot.families.iter().all(|f| f.pending.is_some()));
    assert!(!snapshot.warnings.iter().any(|w| w.starts_with("clock:")));
    assert_eq!(calls.load(Ordering::Relaxed), 2);
    state.confirm_pricing("Claude Sonnet".into()).await?;
    state.db.close().await?;
    task.abort();
    Ok(())
}

#[tokio::test]
async fn explicit_migrate_and_startup_version_gate() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("pricing.db");
    let binary = env!("CARGO_BIN_EXE_factory-api");
    let migrate = || {
        std::process::Command::new(binary)
            .arg("migrate")
            .arg("--pricing-db")
            .arg(&path)
            .output()
    };
    for version in [None, Some(0), Some(2)] {
        if let Some(version) = version {
            let db = rusqlite::Connection::open(&path)?;
            db.pragma_update(None, "user_version", version)?;
        }
        let output = tokio::process::Command::new(binary)
            .arg("--pricing-db-path")
            .arg(&path)
            .arg("--db-path")
            .arg(temp.path().join("requests.db"))
            .arg("--listen")
            .arg("127.0.0.1:0")
            .output()
            .await?;
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("factory-api migrate --pricing-db")
        );
        assert!(!temp.path().join("requests.db").exists());
    }
    let db = rusqlite::Connection::open(&path)?;
    db.pragma_update(None, "user_version", 0)?;
    db.execute_batch(include_str!("../../pricing/tests/fixtures/v0.sql"))?;
    drop(db);
    let before = std::fs::read(&path)?;
    let output = migrate()?;
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("legacy pricing DB found; move it aside first (the installer does this)")
    );
    assert_eq!(std::fs::read(&path)?, before);
    std::fs::rename(&path, temp.path().join("pricing.v0.db"))?;
    for _ in 0..2 {
        let output = migrate()?;
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout)?,
            "pricing user_version=1; tables: price_snapshots, pricing_items, reference_selection, refreshes\n"
        );
    }
    let state = AppState::new(
        "http://127.0.0.1:1".into(),
        temp.path().join("requests.db"),
        path,
        fleet::Config { nodes: vec![] },
    )
    .await?;
    state.db.close().await?;
    Ok(())
}

#[tokio::test]
async fn overload_sheds_requests_times_out_work_and_keeps_sse_open() -> Result<()> {
    tokio::time::timeout(Duration::from_secs(30), async {
        let temp = tempfile::tempdir()?;
        let (upstream, upstream_task) = serve(Router::new().fallback(|| async {
            tokio::time::sleep(Duration::from_secs(60)).await;
            StatusCode::SERVICE_UNAVAILABLE
        }))
        .await;
        let state = test_state(&temp, upstream).await?;
        let (url, task) = serve(router(state.clone())).await;
        let client = reqwest::Client::new();
        let mut stream = client.get(format!("{url}/v1/stream")).send().await?;
        let mut pending = tokio::task::JoinSet::new();
        for _ in 0..40 {
            let client = client.clone();
            let url = url.clone();
            pending.spawn(async move {
                client
                    .get(format!("{url}/v1/gpu"))
                    .send()
                    .await
                    .unwrap()
                    .status()
                    .as_u16()
            });
        }
        let mut shed = 0;
        let mut timed_out = 0;
        while let Some(status) = pending.join_next().await {
            match status? {
                503 => shed += 1,
                504 => timed_out += 1,
                other => panic!("unexpected HTTP {other}"),
            }
        }
        assert!(shed > 0 && timed_out > 0);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), stream.chunk())
                .await
                .is_err()
        );
        state.shutdown.cancel();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), stream.chunk())
                .await??
                .is_none()
        );
        state.db.close().await?;
        task.abort();
        upstream_task.abort();
        Ok(())
    })
    .await
    .context("overload_sheds_requests_times_out_work_and_keeps_sse_open exceeded 30 seconds")?
}

#[tokio::test]
async fn sigterm_exits_with_sse_clients_and_closes_pool_within_five_seconds() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir()?;
    pricing::migrate(temp.path().join("pricing.db"))?;
    // Exercise the real boot clock probe without changing this machine's clock.
    let probe = temp.path().join("timedatectl");
    std::fs::write(&probe, "#!/bin/sh\necho no\n")?;
    std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o755))?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    drop(listener);
    let config = temp.path().join("services.toml");
    std::fs::write(&config, "[[nodes]]\nname='factory-console'\nservices=[]")?;
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_factory-api"))
        .env(
            "PATH",
            format!("{}:{}", temp.path().display(), std::env::var("PATH")?),
        )
        .args([
            "--listen",
            &address.to_string(),
            "--meter-url",
            "http://127.0.0.1:1",
            "--db-path",
        ])
        .arg(temp.path().join("requests.db"))
        .arg("--pricing-db-path")
        .arg(temp.path().join("pricing.db"))
        .arg("--services-config")
        .arg(config)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let client = reqwest::Client::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(response) = client
                .get(format!("http://{address}/v1/health"))
                .send()
                .await
            {
                assert_eq!(
                    response.json::<Value>().await?["status"],
                    "clock_unsynchronized"
                );
                return Ok::<_, anyhow::Error>(());
            }
            assert!(child.try_wait()?.is_none(), "child exited during startup");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await??;
    let mut streams = Vec::new();
    for _ in 0..3 {
        streams.push(
            client
                .get(format!("http://{address}/v1/stream"))
                .send()
                .await?,
        );
    }
    let start = std::time::Instant::now();
    assert!(
        tokio::process::Command::new("kill")
            .args(["-TERM", &child.id().unwrap().to_string()])
            .status()
            .await?
            .success()
    );
    let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output()).await??;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("database pool closed; shutdown complete")
    );
    assert!(start.elapsed() < Duration::from_secs(5));
    eprintln!("SIGTERM with three SSE clients: {:?}", start.elapsed());
    for mut stream in streams {
        while stream.chunk().await?.is_some() {}
    }
    Ok(())
}

/// Run with: cargo test --release -p factory-api benchmark_100k -- --ignored --nocapture
#[tokio::test]
#[ignore = "100k-row HTTP benchmark; run in release mode"]
async fn benchmark_100k() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let state = test_state(&temp, "http://127.0.0.1:1".into()).await?;
    let at = now_ms();
    state
        .db
        .write_pricing(&state.query_scope, move |db| {
            offline_refresh(
                db,
                &pricing::parse_references(pricing::DEFAULT_CONFIG)?,
                at - 31 * 86_400_000,
            )?;
            db.confirm("Claude Sonnet", at - 31 * 86_400_000)?;
            db.confirm("ChatGPT mid-tier", at - 31 * 86_400_000)?;
            Ok(())
        })
        .await?;
    state
        .db
        .write(&state.query_scope, move |db| {
            factory_api::data::sync(
                db,
                (1..=100_000)
                    .map(|id| RequestRecord {
                        id,
                        ts: at - (id % 29) * 86_400_000,
                        endpoint: "/api/chat".into(),
                        model: Some(format!("model-{}", id % 7)),
                        prompt_eval_count: Some(37),
                        eval_count: Some(19),
                        prompt_eval_duration: Some(100_000_000),
                        eval_duration: Some(1_000_000_000),
                        total_duration: Some(id as u64 * 100_000),
                        load_duration: Some(5_000_000),
                        ..Default::default()
                    })
                    .collect(),
            )?;
            Ok(())
        })
        .await?;
    let (url, task) = serve(router(state.clone())).await;
    let client = reqwest::Client::new();
    for path in ["/v1/llm/usage?range=30d", "/v1/pricing"] {
        let mut samples = vec![];
        for _ in 0..40 {
            let started = std::time::Instant::now();
            let value = fetch(&client, &format!("{url}{path}")).await;
            samples.push(started.elapsed());
            if path.contains("usage") {
                assert_eq!(
                    value["totals"],
                    json!({"requests":100_000,"prompt_tokens":3_700_000,"output_tokens":1_900_000})
                );
                let sonnet = value["spend_avoided"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|s| s["family"] == "Claude Sonnet")
                    .unwrap();
                assert!((sonnet["usd"].as_f64().unwrap() - 39.6).abs() < 1e-6);
            } else {
                assert!(
                    value["families"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|f| f["selected"].is_object())
                );
            }
        }
        samples.sort();
        let p95 = samples[37];
        eprintln!(
            "100k cached rows, 40 HTTP samples, {path}: p95={p95:?}, max={:?}",
            samples[39]
        );
        assert!(p95 < Duration::from_millis(200), "{path}: p95 {p95:?}");
    }
    state.db.close().await?;
    task.abort();
    Ok(())
}
