use crate::types::*;
use crate::{AppState, now_ms};
use anyhow::{Result, anyhow, bail, ensure};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    process::Command,
};

pub const DEFAULT_CONFIG: &str = include_str!("../config/services.toml");
#[derive(Clone, Deserialize)]
pub struct Config {
    pub nodes: Vec<NodeConfig>,
}
#[derive(Clone, Deserialize)]
pub struct NodeConfig {
    pub name: String,
    pub services: Vec<ServiceConfig>,
    /// MET-260 per-service interval cache and in-flight probe sharing for this
    /// node's services; not part of the config text. Lives on the node because
    /// entries are per (node, service) and `fleet::Config` has struct literals
    /// in test helpers outside this file's reach.
    #[serde(skip)]
    pub cache: CheckCache,
}
#[derive(Clone, Deserialize)]
pub struct ServiceConfig {
    pub name: String,
    pub kind: ServiceKind,
    pub target: String,
    /// Optional cached-check interval (MET-260): reuse the stored result for
    /// this long; failures retest after 30 s instead. Without it, every collect
    /// probes the service.
    pub interval_s: Option<u64>,
}

fn host_port(target: &str, kind: &str) -> Result<()> {
    let (host, port) = target
        .rsplit_once(':')
        .ok_or_else(|| anyhow::anyhow!("invalid {kind} target"))?;
    ensure!(
        !host.is_empty() && port.parse::<u16>()? > 0,
        "invalid {kind} target"
    );
    Ok(())
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
                    ServiceKind::Tcp => host_port(&service.target, "tcp")?,
                    ServiceKind::Rdp => host_port(&service.target, "rdp")?,
                }
                if let Some(interval_s) = service.interval_s {
                    ensure!(
                        (10..=3600).contains(&interval_s),
                        "interval_s must be 10-3600 s"
                    );
                }
            }
        }
        Ok(config)
    }
}
/// TPKT + X.224 Connection Request with an RDP_NEG_REQ asking for TLS|CredSSP,
/// byte-identical to the request proven against gnome-remote-desktop by hand on
/// factory-console (MET-260). Probing never starts TLS.
const RDP_REQUEST: [u8; 19] = [
    0x03, 0x00, 0x00, 0x13, // TPKT: version 3, total length 19
    0x0e, 0xe0, // X.224 Connection Request length indicator and code
    0x00, 0x00, 0x00, 0x00, // destination and source reference
    0x00, // class 0
    0x01, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00,
    0x00, // RDP_NEG_REQ: type 0x01, flags 0,
          // length 8, requestedProtocols TLS|CredSSP (little-endian)
];
/// The whole probe runs inside the 5 s per-check timeout with margin for the
/// outer collect timeout, so a silent server fails with a specific detail.
pub const RDP_PROBE_TIMEOUT: Duration = Duration::from_millis(4000);

fn protocol_name(protocol: u32) -> String {
    match protocol {
        0 => "standard RDP security".into(),
        1 => "TLS".into(),
        2 => "CredSSP (hybrid)".into(),
        4 => "RDSTLS".into(),
        8 => "CredSSP (hybrid ex)".into(),
        other => format!("protocol 0x{other:08x}"),
    }
}

fn failure_name(code: u32) -> String {
    match code {
        1 => "SSL_REQUIRED_BY_SERVER".into(),
        2 => "SSL_NOT_ALLOWED_BY_SERVER".into(),
        3 => "SSL_CERT_NOT_ON_SERVER".into(),
        4 => "INCONSISTENT_FLAGS".into(),
        5 => "HYBRID_REQUIRED_BY_SERVER".into(),
        6 => "SSL_WITH_USER_AUTH_REQUIRED_BY_SERVER".into(),
        other => format!("failure code 0x{other:08x}"),
    }
}

async fn read_exact_note(stream: &mut TcpStream, buffer: &mut [u8], phase: &str) -> Result<()> {
    // One byte at a time is at most 64 rounds; in exchange a short read reports
    // exactly how far the connection got.
    for index in 0..buffer.len() {
        if let Err(error) = stream.read_exact(&mut buffer[index..index + 1]).await {
            if error.kind() == std::io::ErrorKind::UnexpectedEof {
                bail!(
                    "connection closed after {index} of {} bytes of {phase}",
                    buffer.len()
                );
            }
            bail!("{phase} read failed: {error}");
        }
    }
    Ok(())
}

async fn negotiate(socket: &mut TcpStream) -> Result<String> {
    socket
        .write_all(&RDP_REQUEST)
        .await
        .map_err(|error| anyhow!("request write failed: {error}"))?;
    let mut header = [0u8; 4];
    read_exact_note(socket, &mut header, "the TPKT header").await?;
    ensure!(
        header[0] == 3,
        "TPKT version 0x{:02x} instead of 3",
        header[0]
    );
    let length = u16::from_be_bytes([header[2], header[3]]) as usize;
    ensure!(
        (11..=64).contains(&length),
        "TPKT length {length} outside 11-64"
    );
    let mut body = vec![0u8; length - 4];
    read_exact_note(socket, &mut body, "the X.224 body").await?;
    ensure!(
        body[1] == 0xd0,
        "X.224 code 0x{:02x} instead of Connection Confirm 0xd0",
        body[1]
    );
    // Fixed CC part: length indicator, code, dst-ref, src-ref and class octet.
    let negotiation = &body[7..];
    if negotiation.is_empty() {
        return Ok("legacy negotiation".into());
    }
    ensure!(
        negotiation.len() == 8,
        "negotiation block is {} bytes instead of 8",
        negotiation.len()
    );
    let block_length = u16::from_le_bytes([negotiation[2], negotiation[3]]);
    ensure!(
        block_length == 8,
        "negotiation length {block_length} instead of 8"
    );
    let value = u32::from_le_bytes([
        negotiation[4],
        negotiation[5],
        negotiation[6],
        negotiation[7],
    ]);
    match negotiation[0] {
        0x02 => Ok(format!("RDP_NEG_RSP: {}", protocol_name(value))),
        0x03 => bail!("RDP_NEG_FAILURE: {}", failure_name(value)),
        other => bail!("negotiation type 0x{other:02x} instead of RSP 0x02 or FAILURE 0x03"),
    }
}

pub async fn probe_rdp(target: &str) -> Result<String> {
    probe_rdp_within(target, RDP_PROBE_TIMEOUT).await
}

/// Connects to one `host:port`, sends the fixed X.224 Connection Request and
/// validates the Connection Confirm, all within `budget`. Always closes the
/// socket afterwards and never starts TLS.
pub async fn probe_rdp_within(target: &str, budget: Duration) -> Result<String> {
    let attempt = async {
        let mut socket = TcpStream::connect(target)
            .await
            .map_err(|error| anyhow!("connect failed: {error}"))?;
        let detail = negotiate(&mut socket).await;
        let _ = socket.shutdown().await;
        detail
    };
    match tokio::time::timeout(budget, attempt).await {
        Ok(result) => result,
        Err(_) => bail!("no response within {:.1} s", budget.as_secs_f64()),
    }
}

/// Per-service check cache (MET-260): services with `interval_s` reuse the last
/// result until it is that old, and concurrent collects share one in-flight
/// probe per service. A failed result is reused only for 30 s so recovery
/// shows quickly. The clock is injectable for tests.
#[derive(Clone)]
pub struct CheckCache {
    inner: Arc<CacheInner>,
}
/// One per-service lock guarding its cached check result; concurrent collects
/// share it while a probe is in flight.
type Entry = Arc<tokio::sync::Mutex<Option<Cached>>>;
struct CacheInner {
    now: std::sync::Mutex<Arc<dyn Fn() -> i64 + Send + Sync>>,
    entries: std::sync::Mutex<HashMap<(String, String), Entry>>,
}
#[derive(Clone)]
struct Cached {
    checked_at_ms: i64,
    service: Service,
}
/// Re-probe a failed service after this long instead of `interval_s`.
pub const FAILURE_RETEST_MS: i64 = 30_000;

impl Default for CheckCache {
    fn default() -> Self {
        Self::with_now(crate::now_ms)
    }
}
impl CheckCache {
    pub fn with_now(now: impl Fn() -> i64 + Send + Sync + 'static) -> Self {
        Self {
            inner: Arc::new(CacheInner {
                now: std::sync::Mutex::new(Arc::new(now)),
                entries: std::sync::Mutex::new(HashMap::new()),
            }),
        }
    }
    /// Replaces the clock; tests inject one so they can travel without waiting.
    pub fn set_now(&self, now: impl Fn() -> i64 + Send + Sync + 'static) {
        *self.inner.now.lock().unwrap() = Arc::new(now);
    }
    fn now(&self) -> i64 {
        let now = self.inner.now.lock().unwrap().clone();
        now()
    }
    async fn entry(&self, node: &str, name: &str) -> Entry {
        self.inner
            .entries
            .lock()
            .unwrap()
            .entry((node.to_string(), name.to_string()))
            .or_default()
            .clone()
    }
    pub async fn get_or_check(
        &self,
        node: &str,
        config: &ServiceConfig,
        state: &AppState,
    ) -> Service {
        let Some(interval_s) = config.interval_s else {
            return check(state, config).await;
        };
        // Holding this per-service lock across the probe is what makes
        // concurrent collects share one in-flight probe.
        let entry = self.entry(node, &config.name).await;
        let mut entry = entry.lock().await;
        let now = self.now();
        if let Some(cached) = entry.as_ref() {
            let max_age = if cached.service.ok {
                i64::try_from(interval_s).unwrap_or(i64::MAX) * 1000
            } else {
                FAILURE_RETEST_MS
            };
            if now - cached.checked_at_ms < max_age {
                return cached.service.clone();
            }
        }
        let mut service = check(state, config).await;
        service.checked_at_ms = self.now();
        *entry = Some(Cached {
            checked_at_ms: service.checked_at_ms,
            service: service.clone(),
        });
        service
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
    let mut success_detail = None;
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
            ServiceKind::Rdp => {
                success_detail = Some(probe_rdp(&config.target).await?);
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
        detail: result.err().map(|e| e.to_string()).or(success_detail),
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
    // Without discovery every node reads offline; alerts must not trust that.
    state
        .fleet_discovered
        .store(status.is_object(), std::sync::atomic::Ordering::Release);
    let nodes = futures_util::future::join_all(state.config.nodes.iter().map(|config| async {
        let mut node = node(config, &status);
        node.services =
            futures_util::future::join_all(config.services.iter().map(|service| async {
                match tokio::time::timeout(
                    Duration::from_secs(5),
                    config.cache.get_or_check(&config.name, service, state),
                )
                .await
                {
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
