use anyhow::{Context, Result};
use factory_api::{AppState, alerts, fleet};
use serde_json::{Value, json};
use std::{process::Stdio, time::Duration};

#[tokio::test]
async fn published_backup_default_and_environment_override() -> Result<()> {
    tokio::time::timeout(Duration::from_secs(15), async {
        let temp = tempfile::tempdir()?;
        let requests = temp.path().join("requests.db");
        let pricing = temp.path().join("pricing.db");
        pricing::migrate(&pricing)?;
        let state = AppState::new(
            "http://127.0.0.1:1".into(),
            requests.clone(),
            pricing.clone(),
            fleet::Config { nodes: vec![] },
        )
        .await?;
        assert_eq!(
            alerts::DEFAULT_BACKUP_STATUS,
            "/var/lib/factory-backup-status/status.json"
        );
        assert_eq!(
            state.backup_status,
            std::path::Path::new(alerts::DEFAULT_BACKUP_STATUS)
        );
        state.db.close().await?;
        let help = std::process::Command::new(env!("CARGO_BIN_EXE_factory-api"))
            .env_clear()
            .arg("--help")
            .output()?;
        assert!(help.status.success());
        assert!(
            String::from_utf8(help.stdout)?
                .contains("[default: /var/lib/factory-backup-status/status.json]")
        );

        let status = temp.path().join("override.json");
        std::fs::write(
            &status,
            json!({"meter": {"error": "override backup failure"}}).to_string(),
        )?;
        let config = temp.path().join("fleet.toml");
        std::fs::write(&config, "[[nodes]]\nname = 'sandbox'\nservices = []\n")?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        drop(listener);
        let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_factory-api"))
            .env_clear()
            .env("FACTORY_API_BACKUP_STATUS", status)
            // Network probes stay on loopback; tests never probe real hosts.
            .envs([
                ("FACTORY_API_NETWORK_WAN_TARGETS", "127.0.0.1"),
                ("FACTORY_API_NETWORK_DNS_NAME", "localhost"),
                ("FACTORY_API_NETWORK_TAILNET_TARGET", "127.0.0.1:9"),
                ("FACTORY_API_NETWORK_ROUTE_TABLE", "/nonexistent"),
            ])
            .args([
                "--listen",
                &address.to_string(),
                "--meter-url",
                "http://127.0.0.1:1",
                "--ups-addr",
                "127.0.0.1:1",
                "--disable-pricing-collector",
            ])
            .arg("--db-path")
            .arg(requests)
            .arg("--pricing-db-path")
            .arg(pricing)
            .arg("--services-config")
            .arg(config)
            .arg("--alerts-state")
            .arg(temp.path().join("alerts.json"))
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(1))
            .build()?;
        loop {
            assert!(
                child.try_wait()?.is_none(),
                "factory-api exited before reading the override"
            );
            if let Ok(response) = client
                .get(format!("http://{address}/v1/alerts"))
                .send()
                .await
            {
                let body: Value = response.error_for_status()?.json().await?;
                if body["active"].as_array().is_some_and(|entries| {
                    entries.iter().any(|entry| {
                        entry["key"] == "backup:status"
                            && entry["summary"]
                                .as_str()
                                .is_some_and(|text| text.contains("override backup failure"))
                    })
                }) {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        child.kill().await?;
        child.wait().await?;
        Ok(())
    })
    .await
    .context("backup configuration check exceeded 15 seconds")?
}
