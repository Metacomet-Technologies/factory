use anyhow::{Context, Result};
use axum::{Json, Router, routing::get};
use serde_json::{Value, json};
use std::{
    os::unix::fs::PermissionsExt,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

#[tokio::test]
async fn pricing_configuration_precedence_and_validation() -> Result<()> {
    tokio::time::timeout(Duration::from_secs(15), async {
        let temp = tempfile::tempdir()?;
        for (environment, flags, expected, disabled) in [
            (
                false,
                false,
                ["https://openrouter.ai/api/v1/models", "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"],
                false,
            ),
            (
                true,
                false,
                [
                    "https://env.example/primary",
                    "https://env.example/secondary",
                ],
                true,
            ),
            (
                true,
                true,
                ["http://127.2.3.4/primary", "http://[::1]/secondary"],
                true,
            ),
        ] {
            let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_factory-api"));
            command
                .env_clear()
                .env("RUST_LOG", "factory_api=info")
                .env("NO_COLOR", "1")
                .arg("--db-path")
                .arg(temp.path().join("requests.db"))
                .arg("--pricing-db-path")
                .arg(temp.path().join("missing.db"))
                .kill_on_drop(true);
            if environment {
                command
                    .env(
                        "FACTORY_API_OPENROUTER_FEED_URL",
                        "https://env.example/primary",
                    )
                    .env(
                        "FACTORY_API_LITELLM_FEED_URL",
                        "https://env.example/secondary",
                    )
                    .env(
                        "FACTORY_API_DISABLE_PRICING_COLLECTOR",
                        if flags { "0" } else { "1" },
                    );
            }
            if flags {
                command.args([
                    "--openrouter-feed-url",
                    "http://127.2.3.4/primary?hidden=1",
                    "--litellm-feed-url",
                    "http://[::1]/secondary?hidden=2",
                    "--disable-pricing-collector",
                ]);
            }
            let output = command.output().await?;
            assert!(!output.status.success());
            assert!(String::from_utf8_lossy(&output.stderr).contains("pricing DB missing"));
            let log = String::from_utf8(output.stdout)?;
            for url in expected {
                assert!(log.contains(url), "{log}");
            }
            assert!(
                log.contains(&format!("collector_disabled={disabled}")),
                "{log}"
            );
            assert!(!log.contains("hidden"));
        }
        for flag in ["--openrouter-feed-url", "--litellm-feed-url"] {
            for value in [
                "http://public.example/feed",
                "/relative",
                "garbage",
                "ftp://localhost/feed",
            ] {
                let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_factory-api"))
                    .env_clear()
                    .args([flag, value])
                    .kill_on_drop(true)
                    .output()
                    .await?;
                assert!(!output.status.success());
                let error = String::from_utf8(output.stderr)?;
                assert!(
                    error.contains(flag) && error.contains("feed URL"),
                    "{error}"
                );
            }
        }
        Ok(())
    })
    .await
    .context("configuration check exceeded 15 seconds")?
}

#[tokio::test]
async fn disabled_collector_keeps_manual_http_refresh_and_confirmation() -> Result<()> {
    tokio::time::timeout(Duration::from_secs(20), async {
        let temp = tempfile::tempdir()?;
        pricing::migrate(temp.path().join("pricing.db"))?;
        let probe = temp.path().join("timedatectl");
        std::fs::write(&probe, "#!/bin/sh\necho yes\n")?;
        std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o755))?;
        let config = temp.path().join("fleet.toml");
        std::fs::write(&config, "[[nodes]]\nname='sandbox'\nservices=[]")?;
        let calls = Arc::new(AtomicUsize::new(0));
        let primary_calls = calls.clone();
        let secondary_calls = calls.clone();
        let feed = Router::new()
            .route("/primary", get(move || { primary_calls.fetch_add(1, Ordering::Relaxed); async {
                Json(json!({"data":[{"id":"openai/gpt-6-sol","created":1,"pricing":{"prompt":"0.000002","completion":"0.000010"}}]}))
            }}))
            .route("/secondary", get(move || { secondary_calls.fetch_add(1, Ordering::Relaxed); async {
                Json(json!({"gpt-6-sol":{"litellm_provider":"openai","input_cost_per_token":0.000002,"output_cost_per_token":0.000010}}))
            }}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let feed_url = format!("http://{}", listener.local_addr()?);
        let feed_task = tokio::spawn(async move { axum::serve(listener, feed).await.unwrap() });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        let address = listener.local_addr()?.to_string();
        drop(listener);
        let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_factory-api"))
            .env_clear().env("PATH", format!("{}:/usr/bin:/bin", temp.path().display()))
            // Network probes stay on loopback; tests never probe real hosts.
            .envs([
                ("FACTORY_API_NETWORK_WAN_TARGETS", "127.0.0.1"),
                ("FACTORY_API_NETWORK_DNS_NAME", "localhost"),
                ("FACTORY_API_NETWORK_TAILNET_TARGET", "127.0.0.1:9"),
                ("FACTORY_API_NETWORK_ROUTE_TABLE", "/nonexistent"),
                ("FACTORY_API_NETWORK_SPEED_URL", "http://127.0.0.1:9"),
            ])
            .args(["--listen", &address, "--meter-url", &feed_url, "--disable-pricing-collector",
                "--openrouter-feed-url", &format!("{feed_url}/primary"), "--litellm-feed-url", &format!("{feed_url}/secondary")])
            .arg("--db-path").arg(temp.path().join("requests.db"))
            .arg("--pricing-db-path").arg(temp.path().join("pricing.db"))
            .arg("--services-config").arg(config)
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
            .kill_on_drop(true).spawn()?;
        let client = reqwest::Client::builder().timeout(Duration::from_secs(2)).build()?;
        loop {
            if let Ok(response) = client.get(format!("{url}/v1/health")).send().await {
                assert_eq!(response.json::<Value>().await?["status"], "ok");
                break;
            }
            assert!(child.try_wait()?.is_none());
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // Includes the immediate startup tick and two subsequent scheduling ticks.
        tokio::time::sleep(Duration::from_millis(4500)).await;
        assert_eq!(calls.load(Ordering::Relaxed), 0);
        let refresh = client.post(format!("{url}/v1/pricing/refresh")).send().await?.error_for_status()?.json::<Value>().await?;
        assert_eq!(calls.load(Ordering::Relaxed), 2);
        assert!(refresh["families"].as_array().unwrap().iter().any(|f| f["pending"]["model_id"] == "openai/gpt-6-sol"));
        let confirmed = client.post(format!("{url}/v1/pricing/confirm/ChatGPT%20mid-tier")).send().await?.error_for_status()?.json::<Value>().await?;
        assert!(confirmed["families"].as_array().unwrap().iter().any(|f| f["selected"]["model_id"] == "openai/gpt-6-sol"));
        let snapshot = client.get(format!("{url}/v1/pricing")).send().await?.error_for_status()?.json::<Value>().await?;
        assert_eq!(snapshot, confirmed);
        tokio::time::sleep(Duration::from_millis(2200)).await;
        assert_eq!(calls.load(Ordering::Relaxed), 2);
        child.kill().await?;
        child.wait().await?;
        feed_task.abort();
        Ok(())
    }).await.context("disabled collector check exceeded 20 seconds")?
}
