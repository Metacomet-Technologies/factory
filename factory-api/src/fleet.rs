use crate::types::*;
use crate::{AppState, now_ms};
use anyhow::{Result, bail, ensure};
use serde::Deserialize;
use serde_json::Value;
use std::time::{Duration, Instant};
use tokio::{net::TcpStream, process::Command};

pub const DEFAULT_CONFIG: &str = include_str!("../config/services.toml");
#[derive(Clone, Deserialize)]
pub struct Config {
    pub nodes: Vec<NodeConfig>,
}
#[derive(Clone, Deserialize)]
pub struct NodeConfig {
    pub name: String,
    pub services: Vec<ServiceConfig>,
}
#[derive(Clone, Deserialize)]
pub struct ServiceConfig {
    pub name: String,
    pub kind: ServiceKind,
    pub target: String,
}
impl Config {
    pub fn parse(text: &str) -> Result<Self> {
        let config: Self = toml::from_str(text)?;
        let mut names = std::collections::HashSet::new();
        ensure!(!config.nodes.is_empty(), "no fleet nodes configured");
        for node in &config.nodes {
            ensure!(
                !node.name.is_empty() && names.insert(&node.name),
                "empty or duplicate node name"
            );
            let mut services = std::collections::HashSet::new();
            for service in &node.services {
                ensure!(
                    !service.name.is_empty() && services.insert(&service.name),
                    "empty or duplicate service name"
                );
                match service.kind {
                    ServiceKind::Systemd => ensure!(
                        node.name == "factory-gpu"
                            && !service.target.starts_with('-')
                            && !service.target.is_empty(),
                        "systemd checks are local-only on factory-gpu"
                    ),
                    ServiceKind::Http => {
                        let url = reqwest::Url::parse(&service.target)?;
                        ensure!(
                            matches!(url.scheme(), "http" | "https") && url.host_str().is_some(),
                            "invalid http target"
                        );
                    }
                    ServiceKind::Tcp => {
                        let (host, port) = service
                            .target
                            .rsplit_once(':')
                            .ok_or_else(|| anyhow::anyhow!("invalid tcp target"))?;
                        ensure!(
                            !host.is_empty() && port.parse::<u16>()? > 0,
                            "invalid tcp target"
                        );
                    }
                }
            }
        }
        Ok(config)
    }
}
pub async fn command(program: &str, args: &[&str]) -> Result<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new(program).args(args).kill_on_drop(true).output(),
    )
    .await??;
    if !output.status.success() {
        bail!(
            "{program}: {}{}",
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8(output.stdout)?)
}
pub fn node(config: &NodeConfig, status: &Value) -> Node {
    let peer = status["Peer"]
        .as_object()
        .into_iter()
        .flat_map(|p| p.values())
        .chain(std::iter::once(&status["Self"]))
        .find(|p| {
            p["HostName"].as_str() == Some(&config.name)
                || p["DNSName"]
                    .as_str()
                    .is_some_and(|n| n.split('.').next() == Some(&config.name))
        });
    Node {
        name: config.name.clone(),
        tailscale_ip: peer
            .and_then(|p| p["TailscaleIPs"][0].as_str())
            .map(str::to_owned),
        online: peer.and_then(|p| p["Online"].as_bool()).unwrap_or(false),
        last_seen_ms: peer
            .and_then(|p| p["LastSeen"].as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .filter(|d| d.timestamp() > 0)
            .map(|d| d.timestamp_millis()),
        os: peer.and_then(|p| p["OS"].as_str()).map(str::to_owned),
        services: vec![],
    }
}
async fn check(state: &AppState, config: &ServiceConfig) -> Service {
    let started = Instant::now();
    let mut identity = Value::Null;
    let result: Result<()> = async {
        match config.kind {
            ServiceKind::Http => {
                let response = state.client.get(&config.target).send().await?;
                ensure!(response.status().is_success(), "HTTP {}", response.status());
                if matches!(config.name.as_str(), "meter-http" | "factory-api")
                    || matches!(response.url().path(), "/meter/health" | "/v1/health")
                {
                    // Legacy meters and non-JSON 2xx responses remain healthy but unidentified.
                    identity = response.json().await.unwrap_or(Value::Null);
                }
            }
            ServiceKind::Tcp => {
                TcpStream::connect(&config.target).await?;
            }
            ServiceKind::Systemd => {
                command("systemctl", &["is-active", &config.target]).await?;
            }
        }
        Ok(())
    }
    .await;
    Service {
        name: config.name.clone(),
        kind: config.kind.clone(),
        target: config.target.clone(),
        ok: result.is_ok(),
        latency_ms: Some(started.elapsed().as_secs_f64() * 1000.0),
        detail: result.err().map(|e| e.to_string()),
        checked_at_ms: now_ms(),
        version: identity["version"].as_str().map(str::to_owned),
        git_sha: identity["git_sha"].as_str().map(str::to_owned),
        git_dirty: identity["git_dirty"].as_bool(),
        built_at_ms: identity["built_at_ms"].as_u64(),
        inputs_fingerprint: identity["inputs_fingerprint"].as_str().map(str::to_owned),
    }
}
pub async fn collect(state: &AppState) -> Fleet {
    let status = match command("tailscale", &["status", "--json"])
        .await
        .and_then(|s| Ok(serde_json::from_str(&s)?))
    {
        Ok(status) => status,
        Err(error) => {
            tracing::warn!(%error, "fleet discovery failed");
            Value::Null
        }
    };
    let nodes = futures_util::future::join_all(state.config.nodes.iter().map(|config| async {
        let mut node = node(config, &status);
        node.services =
            futures_util::future::join_all(config.services.iter().map(|service| async {
                match tokio::time::timeout(Duration::from_secs(5), check(state, service)).await {
                    Ok(result) => result,
                    Err(error) => Service {
                        name: service.name.clone(),
                        kind: service.kind.clone(),
                        target: service.target.clone(),
                        ok: false,
                        latency_ms: Some(5000.0),
                        detail: Some(error.to_string()),
                        checked_at_ms: now_ms(),
                        version: None,
                        git_sha: None,
                        git_dirty: None,
                        built_at_ms: None,
                        inputs_fingerprint: None,
                    },
                }
            }))
            .await;
        node
    }))
    .await;
    Fleet {
        generated_at_ms: now_ms(),
        nodes,
    }
}
