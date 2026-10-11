use serde_json::{Value, json};
use std::{net::SocketAddr, time::Duration};

struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn serve(router: axum::Router) -> (String, Server) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    (format!("http://{address}"), Server(task))
}

async fn records(db: &meter::db::Db, count: usize) -> Vec<shared::RequestRecord> {
    for _ in 0..100 {
        let result = db
            .query("SELECT id,record FROM requests ORDER BY id".into())
            .await
            .unwrap();
        let rows: Vec<shared::RequestRecord> = serde_json::from_value(result).unwrap();
        if rows.len() == count {
            return rows;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("meter did not persist {count} records");
}

#[tokio::test]
async fn deterministic_protocols_pass_through_real_meter_parsers() {
    let (fake, _fake_server) = serve(sandbox::fake::router(42)).await;
    let (other, _other_server) = serve(sandbox::fake::router(43)).await;
    let directory = tempfile::tempdir().unwrap();
    let db = meter::db::Db::open(&directory.path().join("meter.db")).unwrap();
    let (meter, _meter_server) = serve(meter::router(meter::AppState::new(
        fake.clone(),
        db.clone(),
    )))
    .await;
    let client = reqwest::Client::new();
    let mut count = 0;
    for path in ["/api/chat", "/api/generate", "/v1/chat/completions"] {
        for stream in [false, true] {
            for model in sandbox::MODELS {
                let request = json!({"model":model,"stream":stream,"prompt":"asymmetric fixture", "messages":[{"role":"user","content":"hello"}]});
                let expected = client
                    .post(format!("{fake}{path}"))
                    .json(&request)
                    .send()
                    .await
                    .unwrap()
                    .text()
                    .await
                    .unwrap();
                let repeat = client
                    .post(format!("{fake}{path}"))
                    .json(&request)
                    .send()
                    .await
                    .unwrap()
                    .text()
                    .await
                    .unwrap();
                assert_eq!(expected, repeat);
                let different = client
                    .post(format!("{other}{path}"))
                    .json(&request)
                    .send()
                    .await
                    .unwrap()
                    .text()
                    .await
                    .unwrap();
                assert_ne!(expected, different);
                let response = client
                    .post(format!("{meter}{path}"))
                    .json(&request)
                    .send()
                    .await
                    .unwrap();
                assert!(response.status().is_success());
                assert_eq!(response.text().await.unwrap(), expected);
                let final_frame: Value = if stream {
                    expected
                        .lines()
                        .filter_map(|line| {
                            serde_json::from_str(line.strip_prefix("data: ").unwrap_or(line)).ok()
                        })
                        .next_back()
                        .unwrap()
                } else {
                    serde_json::from_str(&expected).unwrap()
                };
                count += 1;
                let rows = records(&db, count).await;
                let row = rows.last().unwrap();
                assert_eq!(row.model.as_deref(), Some(model));
                assert_eq!(row.stream, stream);
                assert!(row.error.is_none());
                if path.starts_with("/v1") {
                    assert_eq!(
                        row.prompt_eval_count,
                        final_frame["usage"]["prompt_tokens"].as_u64()
                    );
                    assert_eq!(
                        row.eval_count,
                        final_frame["usage"]["completion_tokens"].as_u64()
                    );
                    assert!(row.usage.is_some());
                } else {
                    assert_eq!(
                        row.prompt_eval_count,
                        final_frame["prompt_eval_count"].as_u64()
                    );
                    assert_eq!(row.eval_count, final_frame["eval_count"].as_u64());
                    assert_eq!(row.load_duration, Some(10_000_000));
                    assert_eq!(
                        row.total_duration,
                        Some(
                            10_000_000
                                + row.prompt_eval_count.unwrap() * 1_000_000
                                + row.eval_count.unwrap() * 20_000_000
                        )
                    );
                }
                assert!((20..=200).contains(&row.prompt_eval_count.unwrap()));
                assert!((8..=32).contains(&row.eval_count.unwrap()));
            }
        }
    }
    for stream in [false, true] {
        let response = client.post(format!("{fake}/v1/chat/completions")).json(&json!({
            "model":"factory-assist", "stream":stream, "tools":[{"type":"function","function":{"name":"read_status","parameters":{"type":"object","properties":{}}}}]
        })).send().await.unwrap().text().await.unwrap();
        let first: Value = if stream {
            serde_json::from_str(
                response
                    .lines()
                    .next()
                    .unwrap()
                    .strip_prefix("data: ")
                    .unwrap(),
            )
            .unwrap()
        } else {
            serde_json::from_str(&response).unwrap()
        };
        let message = &first["choices"][0][if stream { "delta" } else { "message" }];
        assert_eq!(message["tool_calls"][0]["function"]["name"], "read_status");
        assert_eq!(message["tool_calls"][0]["function"]["arguments"], "{}");
    }
    for endpoint in ["/api/ps", "/api/tags"] {
        let response: Value = client
            .get(format!("{fake}{endpoint}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(response["models"].as_array().unwrap().len(), 3);
    }
    assert_eq!(
        pricing::parse_openrouter(&sandbox::fake::openrouter().to_string())
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        pricing::parse_litellm(&sandbox::fake::litellm().to_string())
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn faults_are_observable_through_meter() {
    let (fake, _fake_server) = serve(sandbox::fake::router(42)).await;
    let directory = tempfile::tempdir().unwrap();
    let db = meter::db::Db::open(&directory.path().join("meter.db")).unwrap();
    let (meter, _meter_server) = serve(meter::router(meter::AppState::new(fake, db.clone()))).await;
    let client = reqwest::Client::new();
    let request = json!({"model":"factory-assist","stream":false});
    let started = std::time::Instant::now();
    let response = client
        .post(format!("{meter}/api/chat"))
        .header("X-Fake-Delay-Ms", "80")
        .json(&request)
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    response.bytes().await.unwrap();
    assert!(started.elapsed() >= Duration::from_millis(80));
    let response = client
        .post(format!("{meter}/api/chat"))
        .header("X-Fake-Error", "500")
        .json(&request)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 500);
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"],
        "synthetic failure"
    );
    for path in ["/api/generate", "/v1/chat/completions"] {
        let response = client
            .post(format!("{meter}{path}"))
            .header("X-Fake-Disconnect", "1")
            .json(&json!({"model":"factory-code","stream":true}))
            .send()
            .await
            .unwrap();
        assert!(response.bytes().await.is_err());
    }
    let rows = records(&db, 4).await;
    assert!(rows[0].latency_ms >= 80.0);
    assert_eq!(rows[1].status, 500);
    assert!(rows[1].error.is_some());
    for row in &rows[2..] {
        assert!(row.error.is_some());
        assert_eq!(row.eval_count, None);
    }
    let response = client
        .post(format!("{meter}/api/chat"))
        .header("X-Fake-Delay-Ms", "60001")
        .json(&request)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn seed_has_exact_count_gaps_nulls_bursts_and_repeatable_rows() {
    let directory = tempfile::tempdir().unwrap();
    let end = meter::now_ms() / 86_400_000 * 86_400_000;
    let mut outputs = Vec::new();
    for name in ["one", "two"] {
        let db = meter::db::Db::open(&directory.path().join(name)).unwrap();
        sandbox::seed::seed(&db, 42, 1000, 30, end).await.unwrap();
        let rows = records(&db, 1000).await;
        assert_eq!(rows.last().unwrap().id, 1003);
        for gap in [7, 31, 97] {
            assert!(!rows.iter().any(|r| r.id == gap));
        }
        assert!(
            rows.iter()
                .any(|r| r.eval_count.is_none() && r.model.is_some())
        );
        assert!(rows.iter().any(|r| r.model.is_none()));
        assert!(rows.iter().any(|r| r.status == 500));
        assert!(
            rows.iter()
                .any(|r| r.error.as_deref() == Some("response stream interrupted"))
        );
        for model in sandbox::MODELS {
            assert!(rows.iter().any(|r| r.model.as_deref() == Some(model)));
        }
        for host in ["dgarbs51-synthetic", "david-synthetic"] {
            assert!(rows.iter().any(|r| r.client_hostname == host));
        }
        assert!(rows.windows(2).any(|r| r[1].ts - r[0].ts == 5));
        assert!(rows.windows(2).any(|r| r[1].ts - r[0].ts > 60_000));
        assert!(sandbox::seed::seed(&db, 42, 1000, 30, end).await.is_err());
        let gpu = db
            .query("SELECT id,sample FROM gpu_samples ORDER BY id".into())
            .await
            .unwrap();
        assert!(!gpu.as_array().unwrap().is_empty());
        assert_eq!(gpu[0]["memory_used_mib"], 9255.0);
        outputs.push((serde_json::to_value(rows).unwrap(), gpu));
    }
    assert_eq!(outputs[0], outputs[1]);
    assert_ne!(
        serde_json::to_value(sandbox::seed::record(42, 1, 1000, 30, end)).unwrap(),
        serde_json::to_value(sandbox::seed::record(43, 1, 1000, 30, end)).unwrap()
    );
}
