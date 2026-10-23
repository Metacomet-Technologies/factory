//! Slack alerts for signals factory-api already has (MET-150).
//!
//! Every 10 s the engine turns current signals into per-key verdicts, posts one
//! Slack message when a key opens and a threaded recovery when it clears. State
//! lives in a small JSON file (never SQLite) so restarts do not repost. A source
//! that cannot be read holds its open alerts until readable again. UPS alone
//! alerts on communication loss after 60 s. Never log the Slack token.
use crate::network::Layer;
use crate::network_diagnosis::LinkState;
use crate::network_history::{
    NetworkAlertInput, NetworkEvent, NetworkSpeedOutcome, NetworkSpeedTest,
};
use crate::types::{ActiveAlert, AlertSeverity, Alerts, ClearedAlert, Fleet};
use crate::{AppState, fleet, now_ms};
use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::Ordering,
    time::Duration,
};

pub const DEFAULT_CHANNEL: &str = "C0C9N9HCRG8";
pub const DEFAULT_SLACK_URL: &str = "https://slack.com/api";
pub const DEFAULT_BACKUP_STATUS: &str = "/var/lib/factory-backup-status/status.json";
pub const DASHBOARD_URL: &str = "https://factory-gpu.bearded-pompano.ts.net";
/// systemd credential name; the unit loads it with `LoadCredential=`.
pub const TOKEN_CREDENTIAL: &str = "slack-bot-token";
pub const INTERVAL: Duration = Duration::from_secs(30);
pub const DEFAULT_THROUGHPUT_LOW_MBPS: u32 = 500;

const RECENT: usize = 20;
const NODE_OFFLINE_MS: i64 = 5 * 60_000;
/// "Failing > 2 consecutive checks": open on the third.
const SERVICE_FAILURES: u32 = 3;
const GPU_LIMIT_C: f64 = 85.0;
const GPU_HOT_MS: i64 = 2 * 60_000;
const GPU_SAMPLE_MAX_AGE_MS: i64 = 2 * 60_000;
/// Meter sync runs every 30 s; ten missed cycles is a gap.
const METER_GAP_MS: i64 = 5 * 60_000;
const BACKUP_STALE_MS: i64 = 36 * 3_600_000;
/// Request retention may skip transiently while rollups or costs catch up.
const RETENTION_SKIP_MS: i64 = 24 * 3_600_000;
/// factory-backup.service TimeoutStartSec: in-run "pending" markers older than this are stuck.
const BACKUP_RUN_MS: i64 = 2 * 3_600_000;
const DISPATCH_STALE_MS: i64 = 5 * 60_000;
/// Three 15-minute usage collector intervals.
const USAGE_STALE_MS: i64 = crate::usage::STALE_MS;
const MAX_BACKOFF_MS: i64 = 15 * 60_000;
const MAX_RECOVERY_ATTEMPTS: u32 = 12;
const SOURCES: [&str; 13] = [
    "node",
    "service",
    "gpu",
    "meter",
    "pricing",
    "backup",
    "clock",
    "dispatch",
    "usage",
    "ups",
    "devices",
    "network",
    "retention",
];
const NETWORK_DOWN_MS: i64 = 2 * 60_000;
const NETWORK_SPEED_TESTS: usize = crate::network_history::ALERT_SPEED_TESTS as usize;
const DEVICE_STALE_MS: i64 = 120_000;
const DEVICE_CPU_WARN_C: f64 = 80.0;
const DEVICE_CPU_CRIT_C: f64 = 95.0;
const DEVICE_CPU_WARN_CLEAR_C: f64 = 75.0;
const DEVICE_CPU_CRIT_CLEAR_C: f64 = 90.0;
const DEVICE_CPU_WARN_MS: i64 = 5 * 60_000;
const DEVICE_CPU_CRIT_MS: i64 = 2 * 60_000;
const DEVICE_FS_WARN: f64 = 85.0;
const DEVICE_FS_CRIT: f64 = 95.0;
const DEVICE_FS_WARN_CLEAR: f64 = 80.0;
const DEVICE_FS_CRIT_CLEAR: f64 = 90.0;
const DEVICE_FS_MS: i64 = 10 * 60_000;
const DEVICE_SMART_MS: i64 = 60_000;
const DEVICE_SMART_CLEAR_MS: i64 = 2 * 60_000;

struct DeviceBand {
    warn: f64,
    crit: f64,
    warn_clear: f64,
    crit_clear: f64,
    warn_ms: i64,
    crit_ms: i64,
    unit: &'static str,
}
const CPU_BAND: DeviceBand = DeviceBand {
    warn: DEVICE_CPU_WARN_C,
    crit: DEVICE_CPU_CRIT_C,
    warn_clear: DEVICE_CPU_WARN_CLEAR_C,
    crit_clear: DEVICE_CPU_CRIT_CLEAR_C,
    warn_ms: DEVICE_CPU_WARN_MS,
    crit_ms: DEVICE_CPU_CRIT_MS,
    unit: " C",
};
const FS_BAND: DeviceBand = DeviceBand {
    warn: DEVICE_FS_WARN,
    crit: DEVICE_FS_CRIT,
    warn_clear: DEVICE_FS_WARN_CLEAR,
    crit_clear: DEVICE_FS_CRIT_CLEAR,
    warn_ms: DEVICE_FS_MS,
    crit_ms: DEVICE_FS_MS,
    unit: "%",
};

/// Slack bot token. Debug output is redacted; the value only reaches the HTTP header.
#[derive(Clone)]
pub struct Token(String);
impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Token(redacted)")
    }
}
impl Token {
    pub fn new(value: &str) -> Option<Self> {
        let value = value.trim();
        (!value.is_empty() && value.len() <= 512 && value.bytes().all(|b| b.is_ascii_graphic()))
            .then(|| Self(value.into()))
    }
    /// Reads `$CREDENTIALS_DIRECTORY/slack-bot-token`. Absent or invalid means never post.
    pub fn from_credentials(directory: Option<&Path>) -> Option<Self> {
        let text = std::fs::read_to_string(directory?.join(TOKEN_CREDENTIAL)).ok()?;
        Self::new(&text)
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    /// None keeps state in memory only (tests and embedded states).
    pub state_path: Option<PathBuf>,
    pub channel: String,
    pub slack_url: String,
    pub token: Option<Token>,
    /// `network:throughput_low` opens below this rate in either direction.
    pub network_throughput_low_bps: i64,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            state_path: None,
            channel: DEFAULT_CHANNEL.into(),
            slack_url: DEFAULT_SLACK_URL.into(),
            token: None,
            network_throughput_low_bps: i64::from(DEFAULT_THROUGHPUT_LOW_MBPS) * 1_000_000,
        }
    }
}
pub fn slack_url(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Slack API URL must be http(s) with a host".into());
    }
    Ok(value.trim_end_matches('/').into())
}

#[derive(Clone, Debug, PartialEq)]
pub struct BackupEntry {
    pub name: String,
    pub last_success_ms: Option<i64>,
    pub last_attempt_ms: Option<i64>,
    pub error: Option<String>,
}
/// Latest collector read and the start of its communication-loss grace period.
#[derive(Clone, Debug)]
pub struct UpsRead {
    pub current: Option<crate::ups::UpsCurrent>,
    /// Startup time until the first successful collector read.
    pub last_success_ms: i64,
}

/// One evaluation's inputs. `None` means the source is unreadable right now.
#[derive(Clone, Debug, Default)]
pub struct Signals {
    pub fleet: Option<Fleet>,
    /// False when `tailscale status` failed, so node online flags are unknown.
    pub fleet_discovered: bool,
    /// Latest GPU 0 sample: (ts_ms, temperature_c).
    pub gpu: Option<(i64, f64)>,
    pub meter_synced_at_ms: Option<i64>,
    /// (family, pending model id) for every family with a pending reference change.
    pub pricing_pending: Option<Vec<(String, String)>>,
    pub backup: Option<Vec<BackupEntry>>,
    pub clock_synchronized: Option<bool>,
    /// `Some(None)`: the timer is loaded but has never fired.
    pub dispatch_last_trigger_ms: Option<Option<i64>>,
    /// Collected tools and their last good reading.
    pub usage: Option<Vec<(String, Option<i64>)>>,
    pub ups: Option<UpsRead>,
    pub ups_events: Vec<crate::ups_history::UpsEvent>,
    /// None means the device collector cannot be evaluated. Open device alerts stay open.
    pub devices: Option<crate::devices::DeviceAlertInput>,
    /// Enrolled remote devices, keyed `devices:{device_id}:…` with the phase-1 thresholds.
    pub remote_devices: Vec<(String, crate::devices::DeviceAlertInput)>,
    /// None when network storage cannot be read.
    pub network: Option<NetworkAlertInput>,
    /// Request retention per side ("api", "meter"); None when unreadable.
    pub retention: Vec<(&'static str, Option<crate::types::RequestRetention>)>,
}

enum Verdict {
    Fire(AlertSeverity, String),
    /// Condition present but not yet (or no longer provably) alert-worthy: keep current state.
    Hold,
}
type Findings = BTreeMap<String, Verdict>;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Open {
    key: String,
    severity: AlertSeverity,
    summary: String,
    opened_at_ms: i64,
    /// Slack `ts` of the opening post; recovery threads under it.
    #[serde(default)]
    slack_ts: Option<String>,
    #[serde(default)]
    attempts: u32,
    #[serde(default)]
    next_post_ms: i64,
    #[serde(default)]
    ups: Option<UpsOutage>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct UpsOutage {
    started_ms: i64,
    min_charge: Option<f64>,
    min_runtime: Option<i64>,
    restarted: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Recovery {
    key: String,
    thread_ts: Option<String>,
    text: String,
    attempts: u32,
    next_post_ms: i64,
}
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct Stored {
    version: u32,
    active: Vec<Open>,
    recent: Vec<ClearedAlert>,
    /// Recovery replies and one-shot device notices not yet accepted by Slack.
    outbox: Vec<Recovery>,
    ups_test_result: Option<String>,
    unsafe_shutdowns: BTreeMap<String, u64>,
}

pub struct Engine {
    config: Config,
    client: reqwest::Client,
    stored: Stored,
    pending_since: HashMap<String, i64>,
    failures: HashMap<String, u32>,
    fleet_seen_ms: i64,
    unavailable: BTreeSet<&'static str>,
    dirty: bool,
}

fn one_line(text: &str, limit: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= limit {
        text
    } else {
        format!("{}…", text.chars().take(limit).collect::<String>())
    }
}
fn minutes(ms: i64) -> i64 {
    ms.max(0) / 60_000
}
fn duration(ms: i64) -> String {
    let minutes = minutes(ms);
    if minutes < 120 {
        format!("{minutes} min")
    } else {
        format!("{} h", minutes / 60)
    }
}
fn backoff(attempts: u32) -> i64 {
    (30_000_i64 << attempts.saturating_sub(1).min(10)).min(MAX_BACKOFF_MS)
}
fn reading<T: std::fmt::Display>(value: Option<T>, unit: &str) -> String {
    value.map_or_else(|| "unknown".into(), |v| format!("{v}{unit}"))
}
fn network_peaks(event: &NetworkEvent) -> String {
    let mut text = format!(
        "peak loss {}",
        reading(event.peak_loss_percent.map(|l| l.round()), "%")
    );
    for (name, us) in [("RTT", event.peak_rtt_us), ("jitter", event.peak_mdev_us)] {
        if let Some(us) = us {
            text.push_str(&format!(", peak {name} {:.1} ms", us as f64 / 1000.0));
        }
    }
    text
}
fn mbps(tests: &[NetworkSpeedTest], rate: fn(&NetworkSpeedTest) -> Option<i64>) -> String {
    tests
        .iter()
        .map(|t| reading(rate(t).map(|bps| (bps as f64 / 1e6).round()), ""))
        .collect::<Vec<_>>()
        .join(", ")
}
fn ups_detail(sample: &crate::ups::UpsCurrent) -> String {
    format!(
        "charge {}, runtime {}, load {}, input {}",
        reading(sample.charge_percent, "%"),
        reading(sample.runtime_s, " s"),
        reading(sample.load_w, " W"),
        reading(sample.input_v, " V")
    )
}
impl UpsOutage {
    fn observe(&mut self, charge: Option<f64>, runtime: Option<i64>) {
        self.min_charge = match (self.min_charge, charge) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        self.min_runtime = match (self.min_runtime, runtime) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
    }
}
pub fn open_text(severity: AlertSeverity, summary: &str) -> String {
    let icon = match severity {
        AlertSeverity::Critical => ":rotating_light:",
        AlertSeverity::Warning => ":warning:",
        AlertSeverity::Info => ":information_source:",
    };
    format!("{icon} {summary} · {DASHBOARD_URL}")
}
pub fn recovery_text(summary: &str, open_ms: i64) -> String {
    format!(
        ":white_check_mark: Recovered after {}: {summary} · {DASHBOARD_URL}",
        duration(open_ms)
    )
}

/// `chat.postMessage`; returns the message `ts`.
pub async fn post(
    client: &reqwest::Client,
    config: &Config,
    token: &Token,
    thread_ts: Option<&str>,
    text: &str,
) -> Result<String> {
    let mut body = serde_json::json!({ "channel": config.channel, "text": text });
    if let Some(ts) = thread_ts {
        body["thread_ts"] = ts.into();
    }
    let mut authorization = reqwest::header::HeaderValue::from_str(&format!("Bearer {}", token.0))
        .map_err(|_| anyhow!("invalid Slack token characters"))?;
    authorization.set_sensitive(true);
    let response = client
        .post(format!("{}/chat.postMessage", config.slack_url))
        .header(reqwest::header::AUTHORIZATION, authorization)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/json; charset=utf-8",
        )
        .body(serde_json::to_vec(&body)?)
        .send()
        .await
        .map_err(|e| anyhow!("Slack request failed: {}", e.without_url()))?;
    let status = response.status();
    let reply: serde_json::Value = response
        .json()
        .await
        .map_err(|_| anyhow!("Slack HTTP {status}: unreadable reply"))?;
    if reply["ok"] != true {
        bail!(
            "Slack HTTP {status}: {}",
            reply["error"].as_str().unwrap_or("unknown error")
        );
    }
    reply["ts"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("Slack reply missing ts"))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let temporary = path.with_extension("json.tmp");
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporary)?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)?;
        if let Some(parent) = path.parent() {
            std::fs::File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

impl Engine {
    pub fn load(config: Config) -> Self {
        let stored = match &config.state_path {
            None => Stored::default(),
            Some(path) => match std::fs::read(path) {
                Ok(bytes) => match serde_json::from_slice::<Stored>(&bytes) {
                    Ok(stored) => stored,
                    Err(error) => {
                        let aside = path.with_extension(format!("json.corrupt-{}", now_ms()));
                        let _ = std::fs::rename(path, &aside);
                        tracing::error!(%error, aside = %aside.display(), "alert state unreadable; starting empty");
                        Stored::default()
                    }
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Stored::default(),
                Err(error) => {
                    tracing::error!(%error, "alert state unreadable; starting empty");
                    Stored::default()
                }
            },
        };
        Self {
            config,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("HTTP client"),
            stored: Stored {
                version: 1,
                ..stored
            },
            pending_since: HashMap::new(),
            failures: HashMap::new(),
            fleet_seen_ms: 0,
            unavailable: BTreeSet::new(),
            dirty: false,
        }
    }
    pub fn view(&self) -> Alerts {
        let mut active: Vec<_> = self
            .stored
            .active
            .iter()
            .map(|open| ActiveAlert {
                key: open.key.clone(),
                severity: open.severity,
                summary: open.summary.clone(),
                opened_at_ms: open.opened_at_ms,
            })
            .collect();
        active.sort_by(|a, b| (a.opened_at_ms, &a.key).cmp(&(b.opened_at_ms, &b.key)));
        Alerts {
            active,
            recent: self.stored.recent.clone(),
        }
    }
    /// Evaluate, post due messages and persist changes.
    pub async fn tick(&mut self, now: i64, signals: &Signals) {
        self.evaluate(now, signals);
        // Try to save state before delivery; only shutdown notices require success.
        self.persist();
        self.deliver(now).await;
        self.persist();
    }
    /// Applies one evaluation; returns sources newly reported unavailable.
    pub fn evaluate(&mut self, now: i64, signals: &Signals) -> Vec<&'static str> {
        if let Some(input) = &signals.devices {
            for (drive, &count) in &input.unsafe_shutdowns {
                if self.stored.unsafe_shutdowns.get(drive) == Some(&count) {
                    continue;
                }
                if let Some(previous) = self.stored.unsafe_shutdowns.insert(drive.clone(), count)
                    && count > previous
                {
                    self.stored.outbox.push(Recovery {
                        key: format!("devices:unsafe_shutdowns:{drive}:{count}"),
                        thread_ts: None,
                        text: format!(
                            "factory-gpu: unclean shutdown recorded on {} ({previous} → {count})",
                            one_line(drive, 160)
                        ),
                        attempts: 0,
                        next_post_ms: now,
                    });
                }
                self.dirty = true;
            }
        }
        for open in &mut self.stored.active {
            if let Some(outage) = &mut open.ups {
                if let Some(sample) = signals.ups.as_ref().and_then(|u| u.current.as_ref()) {
                    outage.observe(sample.charge_percent, sample.runtime_s);
                }
                if open.key == "ups:on_battery" {
                    for event in &signals.ups_events {
                        outage.observe(event.min_charge_percent, event.min_runtime_s);
                        outage.restarted |= event.end_reason.as_deref() == Some("restart");
                    }
                }
                self.dirty = true;
            }
        }
        let mut newly = vec![];
        for source in SOURCES {
            match self.findings(source, now, signals) {
                None => {
                    if self.unavailable.insert(source) {
                        tracing::warn!(
                            source,
                            "alert source unavailable; it will not alert until readable"
                        );
                        newly.push(source);
                    }
                }
                Some(findings) => {
                    if self.unavailable.remove(source) {
                        tracing::info!(source, "alert source available again");
                    }
                    self.reconcile(source, now, findings, signals);
                }
            }
        }
        newly
    }
    fn held(&mut self, key: &str, now: i64, hold_ms: i64) -> bool {
        let since = *self.pending_since.entry(key.into()).or_insert(now);
        now - since >= hold_ms
    }
    fn alert_open(&self, key: &str) -> bool {
        self.stored.active.iter().any(|open| open.key == key)
    }
    fn device_level(
        &mut self,
        out: &mut Findings,
        now: i64,
        key: &str,
        reading: Option<Option<f64>>,
        band: &DeviceBand,
        noun: &str,
    ) {
        let DeviceBand {
            warn,
            crit,
            warn_clear,
            crit_clear,
            warn_ms,
            crit_ms,
            unit,
        } = *band;
        let crit_key = format!("{key}:critical");
        let warn_key = format!("{key}:warning");
        let Some(reading) = reading else {
            for name in [&crit_key, &warn_key] {
                if self.alert_open(name) {
                    out.insert(name.clone(), Verdict::Hold);
                }
            }
            return;
        };
        let Some(value) = reading else {
            self.pending_since.remove(&crit_key);
            self.pending_since.remove(&warn_key);
            return;
        };
        let summary = |value: f64, level: &str, threshold: f64| {
            format!("{noun} {value}{unit} ({level} {threshold}{unit})")
        };
        let crit_open = self.alert_open(&crit_key);
        let warn_open = self.alert_open(&warn_key);
        if value >= crit {
            if self.held(&crit_key, now, crit_ms) {
                self.pending_since.remove(&warn_key);
                out.insert(
                    crit_key,
                    Verdict::Fire(AlertSeverity::Critical, summary(value, "critical", crit)),
                );
            } else {
                if crit_open {
                    out.insert(crit_key, Verdict::Hold);
                }
                if warn_open {
                    out.insert(warn_key, Verdict::Hold);
                }
            }
            return;
        }
        if crit_open && value >= crit_clear {
            self.pending_since.remove(&crit_key);
            out.insert(crit_key, Verdict::Hold);
        } else {
            self.pending_since.remove(&crit_key);
        }
        if value >= warn {
            if self.held(&warn_key, now, warn_ms) {
                out.insert(
                    warn_key,
                    Verdict::Fire(AlertSeverity::Warning, summary(value, "warning", warn)),
                );
            } else if warn_open {
                out.insert(warn_key, Verdict::Hold);
            }
        } else if warn_open && value >= warn_clear {
            self.pending_since.remove(&warn_key);
            out.insert(warn_key, Verdict::Hold);
        } else {
            self.pending_since.remove(&warn_key);
        }
    }
    /// factory-gpu uses prefix `devices:` and no label, as in phase 1. A remote device
    /// uses `devices:{id}:` and names itself in each summary. `node_offline` defers
    /// its telemetry alert to the fleet node alert, which already covers that case.
    fn device_findings(
        &mut self,
        now: i64,
        prefix: &str,
        label: &str,
        node_offline: bool,
        input: &crate::devices::DeviceAlertInput,
    ) -> Findings {
        let mut out = Findings::new();
        let stale_key = format!("{prefix}telemetry");
        match input.fast_success_ms {
            _ if node_offline => {
                self.pending_since.remove(&stale_key);
                if self.alert_open(&stale_key) {
                    out.insert(stale_key, Verdict::Hold);
                }
            }
            Some(at) if now.saturating_sub(at) >= DEVICE_STALE_MS => {
                self.pending_since.remove(&stale_key);
                out.insert(
                    stale_key,
                    Verdict::Fire(
                        AlertSeverity::Warning,
                        format!(
                            "{label}device telemetry stale: no fast sample for {}",
                            duration(now - at)
                        ),
                    ),
                );
            }
            Some(_) => {
                self.pending_since.remove(&stale_key);
            }
            None => {
                if self.alert_open(&stale_key) {
                    out.insert(stale_key, Verdict::Hold);
                } else if self.held(&stale_key, now, DEVICE_STALE_MS) {
                    out.insert(
                        stale_key,
                        Verdict::Fire(
                            AlertSeverity::Warning,
                            format!("{label}device telemetry stale: no fast sample for 2 min"),
                        ),
                    );
                }
            }
        }
        self.device_level(
            &mut out,
            now,
            &format!("{prefix}cpu:temperature"),
            input.cpu_temp_c,
            &CPU_BAND,
            &format!("{label}CPU temperature"),
        );
        let fs_prefix = format!("{prefix}fs:");
        match &input.filesystems {
            None => {
                for open in &self.stored.active {
                    if open.key.starts_with(&fs_prefix) {
                        out.insert(open.key.clone(), Verdict::Hold);
                    }
                }
            }
            Some(filesystems) => {
                for fs in filesystems {
                    let id = one_line(&fs.id, 160);
                    self.device_level(
                        &mut out,
                        now,
                        &format!("{fs_prefix}{id}:space"),
                        fs.space_percent.map(Some),
                        &FS_BAND,
                        &format!("{label}filesystem {id} space"),
                    );
                    self.device_level(
                        &mut out,
                        now,
                        &format!("{fs_prefix}{id}:inodes"),
                        fs.inode_percent.map(Some),
                        &FS_BAND,
                        &format!("{label}filesystem {id} inodes"),
                    );
                }
            }
        }
        let smart_prefix = format!("{prefix}smart:");
        match &input.smart {
            None => {
                for open in &self.stored.active {
                    if open.key.starts_with(&smart_prefix) {
                        out.insert(open.key.clone(), Verdict::Hold);
                    }
                }
            }
            Some(drives) => {
                for drive in drives {
                    let key = format!("{smart_prefix}{}", one_line(&drive.id, 160));
                    let open = self.alert_open(&key);
                    let clear = format!("{key}:clear");
                    match drive.unhealthy {
                        Some(true) => {
                            self.pending_since.remove(&clear);
                            if self.held(&key, now, DEVICE_SMART_MS) {
                                out.insert(
                                    key,
                                    Verdict::Fire(
                                        AlertSeverity::Critical,
                                        format!(
                                            "{label}SMART unhealthy for {}",
                                            one_line(&drive.id, 160)
                                        ),
                                    ),
                                );
                            } else if open {
                                out.insert(key, Verdict::Hold);
                            }
                        }
                        Some(false) if open => {
                            if self.held(&clear, now, DEVICE_SMART_CLEAR_MS) {
                                self.pending_since.remove(&key);
                                self.pending_since.remove(&clear);
                            } else {
                                out.insert(key, Verdict::Hold);
                            }
                        }
                        Some(false) => {
                            self.pending_since.remove(&key);
                        }
                        None if open => {
                            out.insert(key, Verdict::Hold);
                        }
                        None => {}
                    }
                }
            }
        }
        out
    }
    fn network_findings(&self, now: i64, input: &NetworkAlertInput) -> Findings {
        let mut out = Findings::new();
        if let Some(event) = &input.open_event
            && let LinkState::Down { layer } = event.state
            && let Some(cause) = match layer {
                Layer::Lan => Some("gateway unreachable"),
                Layer::Wan => Some("ISP outage, every wan target lost"),
                Layer::Dns => Some("name resolution failing"),
                // v1 has no tailnet alert.
                Layer::Tailnet => None,
            }
        {
            let open_ms = now - event.started_ms;
            let verdict = if open_ms >= NETWORK_DOWN_MS {
                Verdict::Fire(
                    AlertSeverity::Critical,
                    format!(
                        "network {} down for {}: {cause}; {}",
                        layer.as_str(),
                        duration(open_ms),
                        network_peaks(event)
                    ),
                )
            } else {
                Verdict::Hold
            };
            out.insert(format!("network:{}_down", layer.as_str()), verdict);
        }
        self.speed_findings(&mut out, input);
        out
    }
    fn speed_findings(&self, out: &mut Findings, input: &NetworkAlertInput) {
        let floor = self.config.network_throughput_low_bps;
        let low = |t: &NetworkSpeedTest| {
            t.download_bps.is_some_and(|bps| bps < floor)
                || t.upload_bps.is_some_and(|bps| bps < floor)
        };
        let ok = &input.recent_ok_tests;
        if ok.len() >= NETWORK_SPEED_TESTS && ok[..NETWORK_SPEED_TESTS].iter().all(low) {
            let tests = &ok[..NETWORK_SPEED_TESTS];
            out.insert(
                "network:throughput_low".into(),
                Verdict::Fire(
                    AlertSeverity::Warning,
                    format!(
                        "network throughput below {} Mb/s in the last {NETWORK_SPEED_TESTS} ok speed tests: download {} Mb/s; upload {} Mb/s",
                        floor / 1_000_000,
                        mbps(tests, |t| t.download_bps),
                        mbps(tests, |t| t.upload_bps)
                    ),
                ),
            );
        } else if ok.first().is_some_and(low) {
            // Only an ok test at or above the floor both ways proves the link recovered.
            out.insert("network:throughput_low".into(), Verdict::Hold);
        }
        let failing = |t: &NetworkSpeedTest| t.outcome != NetworkSpeedOutcome::Ok;
        let recent = &input.recent_tests;
        if recent.len() >= NETWORK_SPEED_TESTS && recent[..NETWORK_SPEED_TESTS].iter().all(failing)
        {
            let outcomes: Vec<_> = recent[..NETWORK_SPEED_TESTS]
                .iter()
                .map(|t| match &t.error {
                    Some(error) => format!("failed: {}", one_line(error, 100)),
                    None => "timeout".into(),
                })
                .collect();
            out.insert(
                "network:speedtest_failing".into(),
                Verdict::Fire(
                    AlertSeverity::Warning,
                    format!(
                        "network speed test failing: the last {NETWORK_SPEED_TESTS} tests did not finish: {}",
                        outcomes.join("; ")
                    ),
                ),
            );
        } else if recent.first().is_some_and(failing) {
            out.insert("network:speedtest_failing".into(), Verdict::Hold);
        }
    }
    fn findings(&mut self, source: &str, now: i64, signals: &Signals) -> Option<Findings> {
        let mut out = Findings::new();
        match source {
            "network" => {
                out = self.network_findings(now, signals.network.as_ref()?);
            }
            "devices" => {
                let input = signals.devices.as_ref()?;
                out = self.device_findings(now, "devices:", "", false, input);
                for (id, input) in &signals.remote_devices {
                    let offline = signals.fleet_discovered
                        && signals.fleet.as_ref().is_some_and(|fleet| {
                            fleet
                                .nodes
                                .iter()
                                .any(|node| node.name == *id && !node.online)
                        });
                    let findings = self.device_findings(
                        now,
                        &format!("devices:{id}:"),
                        &format!("{id}: "),
                        offline,
                        input,
                    );
                    out.extend(findings);
                }
            }
            "ups" => {
                let read = signals.ups.as_ref()?;
                // One 60s grace period measured from the last good read, not two holds.
                if now - read.last_success_ms >= 60_000 {
                    out.insert("ups:comms_lost".into(), Verdict::Fire(
                        AlertSeverity::Warning, "UPS comms lost: no successful read for 60 s; charge unknown, runtime unknown, load unknown, input unknown".into()));
                }
                let Some(sample) = read.current.as_ref().filter(|s| now - s.ts_ms <= 20_000) else {
                    self.pending_since.remove("ups:on_battery");
                    // An unreadable source cannot prove a battery condition has cleared.
                    for open in &self.stored.active {
                        if open.key.starts_with("ups:") {
                            out.entry(open.key.clone()).or_insert(Verdict::Hold);
                        }
                    }
                    return Some(out);
                };
                let detail = ups_detail(sample);
                let thresholds = format!(
                    "shutdown thresholds: charge {}, runtime {}",
                    reading(sample.charge_low_percent, "%"),
                    reading(sample.runtime_low_s, " s")
                );
                match sample.on_battery {
                    Some(true) => {
                        self.pending_since
                            .entry("ups:on_battery".into())
                            .or_insert(sample.ts_ms);
                        let verdict = if self.held("ups:on_battery", now, 30_000) {
                            Verdict::Fire(
                                AlertSeverity::Warning,
                                format!("UPS on battery: {detail}; {thresholds}"),
                            )
                        } else {
                            Verdict::Hold
                        };
                        out.insert("ups:on_battery".into(), verdict);
                    }
                    Some(false) if sample.on_line == Some(true) => {
                        self.pending_since.remove("ups:on_battery");
                    }
                    _ => {
                        self.pending_since.remove("ups:on_battery");
                        out.insert("ups:on_battery".into(), Verdict::Hold);
                    }
                }
                let low_charge = sample
                    .charge_percent
                    .map(|c| c <= sample.charge_warning_percent.unwrap_or(20.0));
                for (key, active, severity, text) in [
                    (
                        "ups:low_battery",
                        if sample.low_battery == Some(true) || low_charge == Some(true) {
                            Some(true)
                        } else if sample.low_battery == Some(false) && low_charge == Some(false) {
                            Some(false)
                        } else {
                            None
                        },
                        AlertSeverity::Critical,
                        format!("UPS low battery: {detail}; {thresholds}"),
                    ),
                    (
                        "ups:replace_battery",
                        sample.replace_battery,
                        AlertSeverity::Warning,
                        format!("UPS replace battery: {detail}"),
                    ),
                ] {
                    match active {
                        Some(true) => {
                            out.insert(key.into(), Verdict::Fire(severity, text));
                        }
                        None => {
                            out.insert(key.into(), Verdict::Hold);
                        }
                        Some(false) => (),
                    }
                }
                // CyberPower cps-hid.c uses test_read_info from usbhid-ups.c:
                // https://github.com/networkupstools/nut/blob/v2.8.4/drivers/usbhid-ups.c
                // 1: Done and passed; 2: Done and warning; 3: Done and error;
                // 4: Aborted; 5: In progress; 6: No test initiated; 7: Test scheduled.
                if let Some(result) = sample
                    .test_result
                    .as_ref()
                    .filter(|result| !matches!(result.as_str(), "In progress" | "Test scheduled"))
                {
                    let changed = self
                        .stored
                        .ups_test_result
                        .as_ref()
                        .is_some_and(|old| old != result);
                    if self.stored.ups_test_result.as_ref() != Some(result) {
                        self.stored.ups_test_result = Some(result.clone());
                        self.dirty = true;
                    }
                    let key = format!("ups:self_test:{}", one_line(result, 160));
                    if !matches!(result.as_str(), "No test initiated" | "Done and passed") {
                        if changed {
                            out.insert(key, Verdict::Fire(AlertSeverity::Warning, format!("UPS self-test failed: {}; {detail}; this is the replace-battery signal on NUT 2.8.4 (CyberPower RB reporting requires NUT >= 2.8.5)", one_line(result, 160))));
                        } else {
                            out.insert(key, Verdict::Hold);
                        }
                    }
                } else {
                    for open in &self.stored.active {
                        if open.key.starts_with("ups:self_test:") {
                            out.insert(open.key.clone(), Verdict::Hold);
                        }
                    }
                }
            }
            "node" => {
                let fleet = signals
                    .fleet
                    .as_ref()
                    .filter(|_| signals.fleet_discovered)?;
                for node in &fleet.nodes {
                    let key = format!("node:{}", node.name);
                    if node.online {
                        self.pending_since.remove(&key);
                    } else if self.held(&key, now, NODE_OFFLINE_MS) {
                        let summary = format!("{} offline for more than 5 min", node.name);
                        out.insert(key, Verdict::Fire(AlertSeverity::Critical, summary));
                    } else {
                        out.insert(key, Verdict::Hold);
                    }
                }
            }
            "service" => {
                let fleet = signals.fleet.as_ref()?;
                // Count collector checks, not engine ticks.
                let fresh = fleet.generated_at_ms != self.fleet_seen_ms;
                self.fleet_seen_ms = fleet.generated_at_ms;
                let mut seen = BTreeSet::new();
                for node in &fleet.nodes {
                    // The node alert covers services on a node Tailscale reports offline.
                    let offline = signals.fleet_discovered && !node.online;
                    for service in &node.services {
                        let key = format!("service:{}/{}", node.name, service.name);
                        seen.insert(key.clone());
                        if service.ok {
                            self.failures.remove(&key);
                            continue;
                        }
                        if offline {
                            out.insert(key, Verdict::Hold);
                            continue;
                        }
                        let count = self.failures.entry(key.clone()).or_default();
                        if fresh {
                            *count += 1;
                        }
                        let verdict = if *count >= SERVICE_FAILURES {
                            let detail = service.detail.as_deref().unwrap_or("check failed");
                            Verdict::Fire(
                                AlertSeverity::Warning,
                                format!(
                                    "{}/{} failing for {count} consecutive checks: {}",
                                    node.name,
                                    service.name,
                                    one_line(detail, 160)
                                ),
                            )
                        } else {
                            Verdict::Hold
                        };
                        out.insert(key, verdict);
                    }
                }
                self.failures.retain(|key, _| seen.contains(key));
            }
            "gpu" => {
                let (_, temperature) = signals
                    .gpu
                    .filter(|(ts, t)| now - ts <= GPU_SAMPLE_MAX_AGE_MS && t.is_finite())?;
                let key = "gpu:temperature".to_string();
                if temperature <= GPU_LIMIT_C {
                    self.pending_since.remove(&key);
                } else if self.held(&key, now, GPU_HOT_MS) {
                    let summary =
                        format!("GPU temperature {temperature:.0} °C, above 85 °C for 2 min");
                    out.insert(key, Verdict::Fire(AlertSeverity::Critical, summary));
                } else {
                    out.insert(key, Verdict::Hold);
                }
            }
            "meter" => {
                let at = signals.meter_synced_at_ms?;
                if now - at > METER_GAP_MS {
                    let summary = format!(
                        "meter sync gap: no successful sync for {}",
                        duration(now - at)
                    );
                    out.insert(
                        "meter:sync".into(),
                        Verdict::Fire(AlertSeverity::Warning, summary),
                    );
                }
            }
            "retention" => {
                for (side, read) in &signals.retention {
                    let key = format!("retention:{side}");
                    let Some(retention) = read else {
                        if self.alert_open(&key) {
                            out.insert(key, Verdict::Hold);
                        }
                        continue;
                    };
                    if let Some(since) = retention
                        .skipped_since_ms
                        .filter(|since| now - since >= RETENTION_SKIP_MS)
                    {
                        let summary = format!(
                            "{side} request retention not pruning for {} ({}): {}",
                            duration(now - since),
                            retention.status,
                            one_line(retention.detail.as_deref().unwrap_or("no detail"), 200)
                        );
                        out.insert(key, Verdict::Fire(AlertSeverity::Warning, summary));
                    }
                }
            }
            "pricing" => {
                for (family, model) in signals.pricing_pending.as_ref()? {
                    let summary = format!(
                        "pricing.changed: new {family} reference model pending: {model} (confirm on the dashboard)"
                    );
                    out.insert(
                        format!("pricing:{family}:{model}"),
                        Verdict::Fire(AlertSeverity::Info, summary),
                    );
                }
            }
            "backup" => {
                let entries = signals.backup.as_ref().filter(|e| !e.is_empty())?;
                let mut problems = vec![];
                for entry in entries {
                    let running = matches!(
                        entry.error.as_deref(),
                        Some("Peer push pending" | "Retention pending")
                    ) && entry
                        .last_attempt_ms
                        .is_some_and(|at| now - at < BACKUP_RUN_MS);
                    if let Some(error) = entry.error.as_deref().filter(|_| !running) {
                        problems.push(format!("{} failed: {}", entry.name, one_line(error, 120)));
                    } else if let Some(at) = entry.last_success_ms {
                        if now - at > BACKUP_STALE_MS {
                            problems.push(format!(
                                "{} last succeeded {} ago",
                                entry.name,
                                duration(now - at)
                            ));
                        }
                    } else if !running && entry.error.is_none() {
                        problems.push(format!("{} has never succeeded", entry.name));
                    }
                }
                if !problems.is_empty() {
                    out.insert(
                        "backup:status".into(),
                        Verdict::Fire(
                            AlertSeverity::Warning,
                            format!("backup: {}", problems.join("; ")),
                        ),
                    );
                }
            }
            "clock" => {
                if !signals.clock_synchronized? {
                    out.insert(
                        "clock:ntp".into(),
                        Verdict::Fire(
                            AlertSeverity::Warning,
                            "factory-gpu clock not NTP-synchronized; pricing refreshes and data writes paused".into(),
                        ),
                    );
                }
            }
            "dispatch" => {
                let summary = match signals.dispatch_last_trigger_ms? {
                    None => Some("factory-dispatch.timer has never fired".to_string()),
                    Some(at) if now - at > DISPATCH_STALE_MS => Some(format!(
                        "factory-dispatch.timer last fired {} ago",
                        duration(now - at)
                    )),
                    Some(_) => None,
                };
                if let Some(summary) = summary {
                    out.insert(
                        "dispatch:timer".into(),
                        Verdict::Fire(AlertSeverity::Warning, summary),
                    );
                }
            }
            "usage" => {
                let stale: Vec<_> = signals
                    .usage
                    .as_ref()?
                    .iter()
                    .filter(|(_, at)| at.is_some_and(|at| now - at > USAGE_STALE_MS))
                    .map(|(tool, _)| tool.as_str())
                    .collect();
                if !stale.is_empty() {
                    out.insert(
                        "usage:stale".into(),
                        Verdict::Fire(
                            AlertSeverity::Warning,
                            format!(
                                "usage snapshot stale: no good {} reading for over 45 min",
                                stale.join(", ")
                            ),
                        ),
                    );
                }
            }
            _ => unreachable!("unknown alert source"),
        }
        Some(out)
    }
    fn reconcile(&mut self, source: &str, now: i64, findings: Findings, signals: &Signals) {
        let prefix = format!("{source}:");
        let (clear, keep): (Vec<_>, Vec<_>) = std::mem::take(&mut self.stored.active)
            .into_iter()
            .partition(|open| open.key.starts_with(&prefix) && !findings.contains_key(&open.key));
        self.stored.active = keep;
        for open in clear {
            self.clear(open, now);
        }
        for (key, verdict) in findings {
            if let Verdict::Fire(severity, summary) = verdict
                && !self.stored.active.iter().any(|open| open.key == key)
            {
                tracing::info!(%key, ?severity, %summary, posting = self.config.token.is_some(), "alert opened");
                let ups = key.starts_with("ups:").then(|| {
                    let mut outage = UpsOutage {
                        started_ms: self.pending_since.get(&key).copied().unwrap_or(now),
                        ..Default::default()
                    };
                    if let Some(sample) = signals.ups.as_ref().and_then(|u| u.current.as_ref()) {
                        outage.observe(sample.charge_percent, sample.runtime_s);
                    }
                    outage
                });
                self.stored.active.push(Open {
                    ups,
                    key,
                    severity,
                    summary,
                    opened_at_ms: now,
                    slack_ts: None,
                    attempts: 0,
                    next_post_ms: now,
                });
                self.dirty = true;
            }
        }
    }
    fn clear(&mut self, open: Open, now: i64) {
        tracing::info!(key = %open.key, summary = %open.summary, "alert cleared");
        if open.severity != AlertSeverity::Info
            && let Some(thread_ts) = open.slack_ts.clone()
        {
            let text = if let Some(outage) = &open.ups {
                format!(
                    ":white_check_mark: Recovered after {} s: {}; minimum charge {}, minimum runtime {}{} · {DASHBOARD_URL}",
                    (now - outage.started_ms).max(0) / 1000,
                    open.summary,
                    reading(outage.min_charge, "%"),
                    reading(outage.min_runtime, " s"),
                    if outage.restarted {
                        "; factory shut down during the outage (UPS history end_reason=restart)"
                    } else {
                        ""
                    }
                )
            } else {
                recovery_text(&open.summary, now - open.opened_at_ms)
            };
            self.stored.outbox.push(Recovery {
                key: open.key.clone(),
                thread_ts: Some(thread_ts),
                text,
                attempts: 0,
                next_post_ms: now,
            });
        }
        self.stored.recent.insert(
            0,
            ClearedAlert {
                key: open.key,
                severity: open.severity,
                summary: open.summary,
                opened_at_ms: open.opened_at_ms,
                cleared_at_ms: now,
            },
        );
        self.stored.recent.truncate(RECENT);
        self.dirty = true;
    }
    /// Posts due openings and recoveries. Without a token nothing is ever posted.
    ///
    /// Each Slack result is persisted before the next network await, so a
    /// shutdown or abort mid-delivery can never forget an acknowledged `ts`
    /// (which would repost the opening or orphan its recovery).
    async fn deliver(&mut self, now: i64) {
        let Some(token) = self.config.token.clone() else {
            return;
        };
        for index in 0..self.stored.active.len() {
            let open = &self.stored.active[index];
            if open.slack_ts.is_some() || open.next_post_ms > now {
                continue;
            }
            let text = open_text(open.severity, &open.summary);
            let result = post(&self.client, &self.config, &token, None, &text).await;
            let open = &mut self.stored.active[index];
            match result {
                Ok(ts) => open.slack_ts = Some(ts),
                Err(error) => {
                    open.attempts += 1;
                    open.next_post_ms = now + backoff(open.attempts);
                    tracing::warn!(key = %open.key, %error, attempts = open.attempts, "Slack alert post failed; will retry");
                }
            }
            self.dirty = true;
            self.persist();
        }
        let mut index = 0;
        while index < self.stored.outbox.len() {
            let recovery = &self.stored.outbox[index];
            if recovery.next_post_ms > now || (recovery.thread_ts.is_none() && self.dirty) {
                index += 1;
                continue;
            }
            let (thread_ts, text) = (recovery.thread_ts.clone(), recovery.text.clone());
            let result = post(
                &self.client,
                &self.config,
                &token,
                thread_ts.as_deref(),
                &text,
            )
            .await;
            let recovery = &mut self.stored.outbox[index];
            match result {
                Ok(_) => {
                    self.stored.outbox.remove(index);
                }
                Err(error) => {
                    recovery.attempts += 1;
                    if recovery.thread_ts.is_some() && recovery.attempts >= MAX_RECOVERY_ATTEMPTS {
                        tracing::error!(key = %recovery.key, %error, "Slack recovery post failed; giving up");
                        self.stored.outbox.remove(index);
                    } else {
                        tracing::warn!(key = %recovery.key, %error, attempts = recovery.attempts, "Slack recovery post failed; will retry");
                        recovery.next_post_ms = now + backoff(recovery.attempts);
                        index += 1;
                    }
                }
            }
            self.dirty = true;
            self.persist();
        }
    }
    fn persist(&mut self) {
        if !self.dirty {
            return;
        }
        let Some(path) = &self.config.state_path else {
            self.dirty = false;
            return;
        };
        let bytes = serde_json::to_vec_pretty(&self.stored).expect("alert state JSON");
        match write_atomic(path, &bytes) {
            Ok(()) => self.dirty = false,
            Err(error) => {
                tracing::warn!(%error, path = %path.display(), "alert state write failed; will retry")
            }
        }
    }
}

/// Shared handle: the collector task owns the engine; `/v1/alerts` reads the view.
pub struct Alerting {
    view: tokio::sync::RwLock<Alerts>,
    engine: std::sync::Mutex<Option<Engine>>,
}
impl Alerting {
    pub fn new(config: Config) -> Self {
        let engine = Engine::load(config);
        Self {
            view: tokio::sync::RwLock::new(engine.view()),
            engine: std::sync::Mutex::new(Some(engine)),
        }
    }
    pub async fn view(&self) -> Alerts {
        self.view.read().await.clone()
    }
}

fn parse_backup(bytes: &[u8]) -> Option<Vec<BackupEntry>> {
    let map: BTreeMap<String, serde_json::Value> = serde_json::from_slice(bytes).ok()?;
    map.into_iter()
        .map(|(name, entry)| {
            entry.is_object().then(|| BackupEntry {
                name,
                last_success_ms: entry["last_success_ms"].as_i64(),
                last_attempt_ms: entry["last_attempt_ms"].as_i64(),
                error: entry["error"].as_str().map(str::to_owned),
            })
        })
        .collect()
}
/// Parses `systemctl show --timestamp=unix -p LoadState -p LastTriggerUSec`.
fn parse_timer(text: &str) -> Option<Option<i64>> {
    let mut load = None;
    let mut last = None;
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("LoadState=") {
            load = Some(value.trim());
        } else if let Some(value) = line.strip_prefix("LastTriggerUSec=") {
            last = Some(value.trim());
        }
    }
    if load? != "loaded" {
        return None;
    }
    match last? {
        "" | "n/a" | "0" => Some(None),
        value => Some(Some(
            value
                .strip_prefix('@')?
                .parse::<i64>()
                .ok()?
                .checked_mul(1000)?,
        )),
    }
}

impl AppState {
    pub async fn alert_signals(&self) -> Signals {
        let now = now_ms();
        let fleet = self.fleet.read().await.clone();
        let backup = async {
            use tokio::io::AsyncReadExt;
            let file = tokio::fs::File::open(&self.backup_status).await.ok()?;
            let mut bytes = vec![];
            file.take(1_000_001).read_to_end(&mut bytes).await.ok()?;
            (bytes.len() <= 1_000_000)
                .then(|| parse_backup(&bytes))
                .flatten()
        };
        let clock = async {
            match fleet::command("timedatectl", &["show", "-p", "NTPSynchronized", "--value"])
                .await
                .ok()?
                .trim()
            {
                "yes" => Some(true),
                "no" => Some(false),
                _ => None,
            }
        };
        let dispatch = async {
            let text = fleet::command(
                "systemctl",
                &[
                    "show",
                    "--timestamp=unix",
                    "-p",
                    "LoadState",
                    "-p",
                    "LastTriggerUSec",
                    "factory-dispatch.timer",
                ],
            )
            .await
            .ok()?;
            parse_timer(&text)
        };
        let pricing = async {
            let pricing = self.pricing().await.ok()?;
            Some(
                pricing
                    .families
                    .into_iter()
                    .filter_map(|f| f.pending.map(|p| (f.family, p.model_id)))
                    .collect(),
            )
        };
        let network = async {
            self.db
                .requests
                .read(&self.query_scope, |db| {
                    crate::network_history::alert_input(db, crate::network::DEVICE_ID)
                })
                .await
                .ok()
        };
        let meter_retention = async {
            let health: serde_json::Value = self.get("/meter/health").await.ok()?;
            serde_json::from_value(health["maintenance"]["retention"].clone()).ok()
        };
        let (
            backup,
            clock_synchronized,
            dispatch_last_trigger_ms,
            pricing_pending,
            usage,
            network,
            meter_retention,
        ) = tokio::join!(
            backup,
            clock,
            dispatch,
            pricing,
            crate::usage::observations(&self.usage_snapshot, now),
            network,
            meter_retention
        );
        let ups = Some(self.ups_latest.read().await.clone());
        let gpu = *self.gpu_latest.lock().expect("GPU sample lock");
        let devices = Some(
            self.devices_latest
                .read()
                .await
                .clone()
                .unwrap_or_else(|| crate::devices::unavailable(now))
                .alert_input(now),
        );
        let remote_devices = self.remote_alert_inputs(now).await;
        Signals {
            fleet: (fleet.generated_at_ms != 0).then_some(fleet),
            fleet_discovered: self.fleet_discovered.load(Ordering::Acquire),
            gpu,
            meter_synced_at_ms: Some(self.meter_synced_at_ms.load(Ordering::Acquire)),
            pricing_pending,
            backup,
            clock_synchronized,
            dispatch_last_trigger_ms,
            usage,
            ups,
            ups_events: vec![],
            devices,
            remote_devices,
            network,
            retention: vec![("api", Some(self.retention())), ("meter", meter_retention)],
        }
    }
    pub(crate) fn start_alerts(&self) -> Option<tokio::task::JoinHandle<()>> {
        let mut engine = self
            .alerts
            .engine
            .lock()
            .expect("alert engine lock")
            .take()?;
        let mut state = self.clone();
        Some(tokio::spawn(async move {
            // UPS follows its 10s collector; other source reads keep their 30s cadence.
            let ups_interval = Duration::from_secs(10);
            let mut timer =
                tokio::time::interval_at(tokio::time::Instant::now() + ups_interval, ups_interval);
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut signals = Signals::default();
            let mut next_collection = 0;
            loop {
                tokio::select! { biased;
                    _ = state.shutdown.cancelled() => break,
                    _ = state.ups_changed.notified() => (),
                    _ = timer.tick() => (),
                }
                state.query_scope = factory_db::Scope::default();
                let work = async {
                    if now_ms() >= next_collection {
                        signals = state.alert_signals().await;
                        next_collection = now_ms() + INTERVAL.as_millis() as i64;
                    }
                    signals.ups = Some(state.ups_latest.read().await.clone());
                    signals.ups_events.clear();
                    if let Some(since) = engine
                        .stored
                        .active
                        .iter()
                        .filter(|a| a.key == "ups:on_battery")
                        .map(|a| {
                            a.ups
                                .as_ref()
                                .map_or(a.opened_at_ms - 30_000, |u| u.started_ms)
                        })
                        .min()
                    {
                        match state
                            .db
                            .requests
                            .read(&state.query_scope, move |db| {
                                crate::ups_history::alert_events(db, since)
                            })
                            .await
                        {
                            Ok(events) => signals.ups_events = events,
                            Err(error) => {
                                tracing::warn!(%error, "UPS recovery history unavailable; holding battery alert");
                                if let Some(read) = &mut signals.ups {
                                    read.current = None;
                                }
                            }
                        }
                    }
                    engine.tick(now_ms(), &signals).await;
                    *state.alerts.view.write().await = engine.view();
                };
                // Shutdown (and main's abort) may drop `work` mid-post: every acknowledged
                // Slack result is already on disk, so a restart neither reposts nor orphans it.
                tokio::select! { biased;
                    _ = state.shutdown.cancelled() => break,
                    _ = work => (),
                }
            }
        }))
    }
}

/// One-time live check: an opening post plus a threaded reply.
pub async fn send_test(config: &Config) -> Result<String> {
    let token = config
        .token
        .as_ref()
        .context("no Slack token in $CREDENTIALS_DIRECTORY/slack-bot-token")?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;
    let ts = post(
        &client,
        config,
        token,
        None,
        &open_text(
            AlertSeverity::Info,
            "factory-api alert test from factory-gpu (no action needed)",
        ),
    )
    .await?;
    post(
        &client,
        config,
        token,
        Some(&ts),
        &recovery_text("factory-api alert test", 0),
    )
    .await?;
    Ok(ts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Node, Service, ServiceKind};
    use axum::{Json, Router, extract::State, http::HeaderMap, routing::post};
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct FakeSlack {
        posts: Arc<Mutex<Vec<Value>>>,
        fail: Arc<Mutex<u32>>,
        /// Requests numbered at or after this (1-based) hang and are never acknowledged.
        block_from: Arc<Mutex<Option<usize>>>,
        received: Arc<std::sync::atomic::AtomicUsize>,
        blocked: Arc<tokio::sync::Notify>,
    }
    async fn chat(
        State(slack): State<FakeSlack>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        assert_eq!(headers["authorization"], "Bearer xoxb-test-token");
        let number = slack.received.fetch_add(1, Ordering::SeqCst) + 1;
        let block = slack
            .block_from
            .lock()
            .unwrap()
            .is_some_and(|from| number >= from);
        if block {
            slack.blocked.notify_one();
            std::future::pending::<()>().await;
        }
        let mut fail = slack.fail.lock().unwrap();
        if *fail > 0 {
            *fail -= 1;
            return Json(json!({"ok": false, "error": "ratelimited"}));
        }
        let mut posts = slack.posts.lock().unwrap();
        posts.push(body);
        Json(json!({"ok": true, "ts": format!("1791900000.{:06}", posts.len())}))
    }
    async fn fake_slack() -> (FakeSlack, String) {
        let slack = FakeSlack::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/api", listener.local_addr().unwrap());
        let app = Router::new()
            .route("/api/chat.postMessage", post(chat))
            .with_state(slack.clone());
        tokio::spawn(async move { axum::serve(listener, app).await });
        (slack, url)
    }
    fn config(url: &str, state: Option<PathBuf>, token: bool) -> Config {
        Config {
            state_path: state,
            channel: "C-test".into(),
            slack_url: url.into(),
            token: token.then(|| Token::new("xoxb-test-token\n").unwrap()),
            ..Config::default()
        }
    }
    fn service(name: &str, ok: bool) -> Service {
        Service {
            name: name.into(),
            kind: ServiceKind::Http,
            target: "http://127.0.0.1:1/".into(),
            ok,
            latency_ms: None,
            detail: (!ok).then(|| "HTTP 503\nService Unavailable".into()),
            checked_at_ms: 0,
            version: None,
            git_sha: None,
            git_dirty: None,
            built_at_ms: None,
            inputs_fingerprint: None,
        }
    }
    fn fleet(at: i64, console_online: bool, ollama_ok: bool) -> Signals {
        let node = |name: &str, online, services| Node {
            name: name.into(),
            tailscale_ip: None,
            online,
            last_seen_ms: None,
            os: None,
            services,
        };
        Signals {
            fleet: Some(Fleet {
                generated_at_ms: at,
                nodes: vec![
                    node(
                        "factory-gpu",
                        true,
                        vec![
                            service("ollama-http", ollama_ok),
                            service("meter-http", true),
                        ],
                    ),
                    node(
                        "factory-console",
                        console_online,
                        vec![service("rdp-tcp", console_online)],
                    ),
                ],
            }),
            fleet_discovered: true,
            meter_synced_at_ms: Some(at),
            ..Default::default()
        }
    }
    /// (name, last_success_ms, last_attempt_ms, error)
    type BackupRow<'a> = (&'a str, Option<i64>, Option<i64>, Option<&'a str>);
    const T0: i64 = 1_791_900_000_000;
    const MIN: i64 = 60_000;

    fn ups(at: i64, status: &str, charge: f64, runtime: i64, result: &str) -> Signals {
        let sample = serde_json::from_value(json!({
            "ts_ms": at, "status": status, "flags": status.split_whitespace().collect::<Vec<_>>(),
            "on_line": status.contains("OL"), "on_battery": status.contains("OB"),
            "low_battery": status.contains("LB"), "replace_battery": status.contains("RB"),
            "charge_percent": charge, "charge_low_percent": 10, "charge_warning_percent": 20,
            "runtime_s": runtime, "runtime_low_s": 120, "load_w": 144, "input_v": 121,
            "test_result": result
        }))
        .unwrap();
        Signals {
            ups: Some(UpsRead {
                current: Some(sample),
                last_success_ms: at,
            }),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn ups_debounce_restart_minima_and_message_snapshots() {
        let (slack, url) = fake_slack().await;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("alerts.json");
        let mut engine = Engine::load(config(&url, Some(path.clone()), true));
        engine
            .tick(T0, &ups(T0, "OB DISCHRG", 80.0, 900, "Done and passed"))
            .await;
        engine
            .tick(
                T0 + 10_000,
                &ups(T0 + 10_000, "OL", 80.0, 900, "Done and passed"),
            )
            .await;
        assert!(slack.posts.lock().unwrap().is_empty());
        for seconds in [20, 49] {
            let at = T0 + seconds * 1000;
            engine
                .tick(at, &ups(at, "OB DISCHRG", 48.0, 600, "Done and passed"))
                .await;
        }
        assert!(slack.posts.lock().unwrap().is_empty());
        let at = T0 + 51_000;
        engine
            .tick(at, &ups(at, "OB DISCHRG", 48.0, 600, "Done and passed"))
            .await;
        assert_eq!(engine.view().active[0].key, "ups:on_battery");
        assert_eq!(
            slack.posts.lock().unwrap()[0],
            json!({"channel":"C-test", "text":format!(":warning: UPS on battery: charge 48%, runtime 600 s, load 144 W, input 121 V; shutdown thresholds: charge 10%, runtime 120 s · {DASHBOARD_URL}")})
        );
        engine
            .tick(
                T0 + 60_000,
                &ups(T0 + 60_000, "OB", 35.0, 450, "Done and passed"),
            )
            .await;
        drop(engine);
        let mut restarted = Engine::load(config(&url, Some(path.clone()), true));
        // Holds survive restart even though the in-memory pending timer does not.
        restarted
            .tick(
                T0 + 70_000,
                &ups(T0 + 70_000, "OB", 40.0, 500, "Done and passed"),
            )
            .await;
        assert_eq!(slack.posts.lock().unwrap().len(), 1);
        let mut recovered = ups(T0 + 111_000, "OL", 60.0, 700, "Done and passed");
        recovered.ups_events.push(crate::ups_history::UpsEvent {
            id: 1,
            kind: "on_battery".into(),
            started_ms: T0 + 20_000,
            ended_ms: Some(T0 + 70_000),
            min_charge_percent: Some(32.0),
            min_runtime_s: Some(390),
            detail: None,
            end_reason: Some("restart".into()),
        });
        restarted.tick(T0 + 111_000, &recovered).await;
        let posts = slack.posts.lock().unwrap().clone();
        assert_eq!(posts.len(), 2);
        assert_eq!(
            posts[1],
            json!({"channel":"C-test", "thread_ts":posts_ts(1), "text":format!(":white_check_mark: Recovered after 91 s: UPS on battery: charge 48%, runtime 600 s, load 144 W, input 121 V; shutdown thresholds: charge 10%, runtime 120 s; minimum charge 32%, minimum runtime 390 s; factory shut down during the outage (UPS history end_reason=restart) · {DASHBOARD_URL}")})
        );
        let reloaded = Engine::load(config(&url, Some(path), true));
        assert!(reloaded.view().active.is_empty());
        assert_eq!(reloaded.view().recent[0].key, "ups:on_battery");
    }

    #[tokio::test]
    async fn ups_low_replace_and_comms_boundaries() {
        let (slack, url) = fake_slack().await;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("alerts.json");
        let mut engine = Engine::load(config(&url, Some(path.clone()), true));
        engine
            .tick(T0, &ups(T0, "OL", 20.1, 900, "No test initiated"))
            .await;
        assert!(slack.posts.lock().unwrap().is_empty());
        engine
            .tick(
                T0 + 1000,
                &ups(T0 + 1000, "OL", 20.0, 800, "No test initiated"),
            )
            .await;
        assert_eq!(engine.view().active[0].severity, AlertSeverity::Critical);
        assert_eq!(
            slack.posts.lock().unwrap()[0]["text"],
            format!(
                ":rotating_light: UPS low battery: charge 20%, runtime 800 s, load 144 W, input 121 V; shutdown thresholds: charge 10%, runtime 120 s · {DASHBOARD_URL}"
            )
        );
        engine
            .tick(
                T0 + 2000,
                &ups(T0 + 2000, "OB LB RB", 80.0, 900, "No test initiated"),
            )
            .await;
        assert_eq!(engine.view().active.len(), 2);
        assert_eq!(
            slack.posts.lock().unwrap()[1]["text"],
            format!(
                ":warning: UPS replace battery: charge 80%, runtime 900 s, load 144 W, input 121 V · {DASHBOARD_URL}"
            )
        );
        let lost = Signals {
            ups: Some(UpsRead {
                current: None,
                last_success_ms: T0 + 2000,
            }),
            ..Default::default()
        };
        engine.tick(T0 + 61_999, &lost).await;
        assert_eq!(slack.posts.lock().unwrap().len(), 2);
        engine.tick(T0 + 62_000, &lost).await;
        assert_eq!(
            slack.posts.lock().unwrap()[2]["text"],
            format!(
                ":warning: UPS comms lost: no successful read for 60 s; charge unknown, runtime unknown, load unknown, input unknown · {DASHBOARD_URL}"
            )
        );
        assert_eq!(
            engine.view().active.len(),
            3,
            "unreadable UPS must not clear battery alerts"
        );
        drop(engine);
        let mut engine = Engine::load(config(&url, Some(path), true));
        let startup = Signals {
            ups: Some(UpsRead {
                current: None,
                last_success_ms: T0 + 63_000,
            }),
            ..Default::default()
        };
        engine.tick(T0 + 63_000, &startup).await;
        assert_eq!(engine.view().active.len(), 3);
        assert_eq!(slack.posts.lock().unwrap().len(), 3);
        engine
            .tick(
                T0 + 72_000,
                &ups(T0 + 72_000, "OL", 90.0, 1200, "No test initiated"),
            )
            .await;
        let posts = slack.posts.lock().unwrap().clone();
        assert_eq!(posts.len(), 6);
        assert_eq!(posts[3]["thread_ts"], posts_ts(1));
        assert_eq!(posts[4]["thread_ts"], posts_ts(2));
        assert_eq!(posts[5]["thread_ts"], posts_ts(3));
        assert!(engine.view().active.is_empty());
    }

    #[tokio::test]
    async fn ups_self_test_posts_once_per_result_change_across_restart() {
        let (slack, url) = fake_slack().await;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("alerts.json");
        let mut engine = Engine::load(config(&url, Some(path.clone()), true));
        let mut at = T0;
        // Transients do not establish a baseline; the first terminal result does.
        for result in [
            "In progress",
            "Test scheduled",
            "Done and warning",
            "In progress",
            "Done and warning",
            "Done and passed",
            "In progress",
            "Done and passed",
        ] {
            engine.tick(at, &ups(at, "OL", 80.0, 900, result)).await;
            at += 1000;
            assert!(slack.posts.lock().unwrap().is_empty());
            assert!(engine.view().active.is_empty());
        }
        // A running/scheduled test neither clears nor reposts an existing failure.
        for result in [
            "Done and warning",
            "In progress",
            "Done and warning",
            "Test scheduled",
            "Done and warning",
        ] {
            engine.tick(at, &ups(at, "OL", 80.0, 900, result)).await;
            at += 1000;
            assert_eq!(slack.posts.lock().unwrap().len(), 1);
            assert_eq!(
                engine.view().active[0].key,
                "ups:self_test:Done and warning"
            );
        }
        assert_eq!(
            slack.posts.lock().unwrap()[0]["text"],
            format!(
                ":warning: UPS self-test failed: Done and warning; charge 80%, runtime 900 s, load 144 W, input 121 V; this is the replace-battery signal on NUT 2.8.4 (CyberPower RB reporting requires NUT >= 2.8.5) · {DASHBOARD_URL}"
            )
        );
        engine
            .tick(at, &ups(at, "OL", 80.0, 900, "In progress"))
            .await;
        at += 1000;
        drop(engine);
        let mut engine = Engine::load(config(&url, Some(path), true));
        for result in ["Done and warning", "In progress"] {
            engine.tick(at, &ups(at, "OL", 80.0, 900, result)).await;
            at += 1000;
            assert_eq!(slack.posts.lock().unwrap().len(), 1);
            assert_eq!(
                engine.view().active[0].key,
                "ups:self_test:Done and warning"
            );
        }
        engine
            .tick(at, &ups(at, "OL", 80.0, 900, "Done and passed"))
            .await;
        at += 1000;
        let posts = slack.posts.lock().unwrap().clone();
        assert_eq!(posts.len(), 2);
        assert_eq!(posts[1]["thread_ts"], posts_ts(1));
        assert!(
            posts[1]["text"]
                .as_str()
                .unwrap()
                .starts_with(":white_check_mark: Recovered")
        );
        assert!(engine.view().active.is_empty());
        for result in [
            "Done and passed",
            "Done and error",
            "Done and passed",
            "Done and warning",
            "Done and warning",
            "Aborted",
            "Aborted",
        ] {
            engine.tick(at, &ups(at, "OL", 80.0, 900, result)).await;
            at += 1000;
        }
        assert_eq!(
            texts_containing(&slack, ":warning: UPS self-test failed"),
            4
        );
        assert_eq!(engine.view().active.len(), 1);
        assert_eq!(engine.view().active[0].key, "ups:self_test:Aborted");
        engine
            .tick(at, &ups(at, "OL", 80.0, 900, "No test initiated"))
            .await;
        assert!(engine.view().active.is_empty());
        let posts = slack.posts.lock().unwrap();
        assert_eq!(posts.len(), 8);
        assert_eq!(posts[7]["thread_ts"], posts_ts(6));
    }

    #[tokio::test]
    async fn opens_once_debounces_and_threads_recovery() {
        let (slack, url) = fake_slack().await;
        let mut engine = Engine::load(config(&url, None, true));
        // Offline under five minutes: held, not posted.
        for minute in 0..5 {
            let now = T0 + minute * MIN;
            engine.tick(now, &fleet(now, false, true)).await;
        }
        assert!(slack.posts.lock().unwrap().is_empty());
        assert!(engine.view().active.is_empty());
        let open_at = T0 + 5 * MIN;
        engine.tick(open_at, &fleet(open_at, false, true)).await;
        // Still offline for 20 more minutes: no reposts.
        for minute in 6..26 {
            let now = T0 + minute * MIN;
            engine.tick(now, &fleet(now, false, true)).await;
        }
        let posts = slack.posts.lock().unwrap().clone();
        assert_eq!(posts.len(), 1, "{posts:?}");
        assert_eq!(
            posts[0],
            json!({"channel": "C-test", "text": format!(":rotating_light: factory-console offline for more than 5 min · {DASHBOARD_URL}")})
        );
        let view = engine.view();
        assert_eq!(view.active.len(), 1);
        assert_eq!(view.active[0].key, "node:factory-console");
        assert_eq!(view.active[0].severity, AlertSeverity::Critical);
        assert_eq!(view.active[0].opened_at_ms, open_at);
        // Online again: one threaded recovery under the original ts.
        let back = T0 + 27 * MIN;
        engine.tick(back, &fleet(back, true, true)).await;
        engine
            .tick(back + MIN, &fleet(back + MIN, true, true))
            .await;
        let posts = slack.posts.lock().unwrap().clone();
        assert_eq!(posts.len(), 2);
        assert_eq!(posts[1]["thread_ts"], "1791900000.000001");
        assert_eq!(posts[1]["channel"], "C-test");
        assert_eq!(
            posts[1]["text"],
            format!(
                ":white_check_mark: Recovered after 22 min: factory-console offline for more than 5 min · {DASHBOARD_URL}"
            )
        );
        let view = engine.view();
        assert!(view.active.is_empty());
        assert_eq!(view.recent.len(), 1);
        assert_eq!(view.recent[0].cleared_at_ms, back);
        assert_eq!(view.recent[0].opened_at_ms, open_at);
    }

    #[tokio::test]
    async fn unwritable_state_blocks_only_shutdown_notices() {
        use std::os::unix::fs::PermissionsExt;
        let (slack, url) = fake_slack().await;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("alerts.json");
        let cfg = config(&url, Some(path), true);
        let signals = |at, ok, count| Signals {
            devices: Some(crate::devices::DeviceAlertInput {
                fast_success_ms: Some(at),
                unsafe_shutdowns: BTreeMap::from([("wwn-a".into(), count)]),
                ..Default::default()
            }),
            ..fleet(at, true, ok)
        };
        let mut engine = Engine::load(cfg.clone());
        engine.tick(T0, &signals(T0, true, 129)).await;
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        for check in 1..=3 {
            let at = T0 + check * MIN;
            engine.tick(at, &signals(at, false, 130)).await;
        }
        let blocked_posts = slack.posts.lock().unwrap().clone();
        engine
            .tick(T0 + 4 * MIN, &signals(T0 + 4 * MIN, true, 130))
            .await;
        let recovered_posts = slack.posts.lock().unwrap().clone();
        // Only the baseline was saved, so restart must detect the increase again.
        drop(engine);
        let mut engine = Engine::load(cfg.clone());
        engine
            .tick(T0 + 5 * MIN, &signals(T0 + 5 * MIN, true, 130))
            .await;
        let restarted_posts = slack.posts.lock().unwrap().clone();
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(blocked_posts.len(), 1);
        assert!(
            blocked_posts[0]["text"]
                .as_str()
                .unwrap()
                .contains("ollama-http failing")
        );
        assert_eq!(recovered_posts.len(), 2);
        assert_eq!(recovered_posts[1]["thread_ts"], posts_ts(1));
        assert_eq!(restarted_posts, recovered_posts);
        engine
            .tick(T0 + 6 * MIN, &signals(T0 + 6 * MIN, true, 130))
            .await;
        drop(engine);
        let mut engine = Engine::load(cfg);
        engine
            .tick(T0 + 7 * MIN, &signals(T0 + 7 * MIN, true, 130))
            .await;
        let posts = slack.posts.lock().unwrap().clone();
        assert_eq!(posts.len(), 3);
        assert_eq!(
            posts[2],
            json!({"channel":"C-test", "text":"factory-gpu: unclean shutdown recorded on wwn-a (129 → 130)"})
        );
    }

    #[tokio::test]
    async fn unsafe_shutdown_increases_survive_restarts_per_drive() {
        let (slack, url) = fake_slack().await;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("alerts.json");
        let signals = |a, b| Signals {
            devices: Some(crate::devices::DeviceAlertInput {
                fast_success_ms: Some(T0),
                unsafe_shutdowns: BTreeMap::from([("wwn-a".into(), a), ("wwn-b".into(), b)]),
                ..Default::default()
            }),
            ..Default::default()
        };
        let cfg = config(&url, Some(path), true);
        let mut engine = Engine::load(cfg.clone());
        engine.tick(T0, &signals(129, 4)).await;
        assert!(slack.posts.lock().unwrap().is_empty());
        drop(engine);
        let mut engine = Engine::load(cfg.clone());
        engine.tick(T0 + 1, &signals(129, 4)).await;
        assert!(slack.posts.lock().unwrap().is_empty());
        engine.tick(T0 + 2, &signals(130, 4)).await;
        engine.tick(T0 + 3, &signals(130, 4)).await;
        let posts = slack.posts.lock().unwrap().clone();
        assert_eq!(
            posts,
            vec![
                json!({"channel":"C-test", "text":"factory-gpu: unclean shutdown recorded on wwn-a (129 → 130)"})
            ]
        );
        drop(engine);
        let mut engine = Engine::load(cfg.clone());
        engine.tick(T0 + 4, &signals(130, 4)).await;
        assert_eq!(slack.posts.lock().unwrap().len(), 1);
        // Persist a failed delivery, then retry it after restart without losing the increase.
        *slack.fail.lock().unwrap() = 1;
        engine.tick(T0 + 5, &signals(130, 7)).await;
        drop(engine);
        let mut engine = Engine::load(cfg);
        engine.tick(T0 + 30_005, &signals(130, 7)).await;
        engine.tick(T0 + 30_006, &signals(130, 7)).await;
        let posts = slack.posts.lock().unwrap().clone();
        assert_eq!(posts.len(), 2);
        assert_eq!(
            posts[1]["text"],
            "factory-gpu: unclean shutdown recorded on wwn-b (4 → 7)"
        );
        assert!(engine.view().active.is_empty());
    }

    #[tokio::test]
    async fn restart_keeps_state_without_reposting() {
        use std::os::unix::fs::PermissionsExt;
        let (slack, url) = fake_slack().await;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("alerts.json");
        let mut first = Engine::load(config(&url, Some(path.clone()), true));
        for check in 0..3 {
            let now = T0 + check * 30_000;
            first.tick(now, &fleet(now, true, false)).await;
        }
        assert_eq!(slack.posts.lock().unwrap().len(), 1);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        drop(first);
        // A restarted engine has no failure counts, yet the open alert stays open.
        let mut second = Engine::load(config(&url, Some(path.clone()), true));
        assert_eq!(
            second.view().active[0].key,
            "service:factory-gpu/ollama-http"
        );
        for check in 3..10 {
            let now = T0 + check * 30_000;
            second.tick(now, &fleet(now, true, false)).await;
        }
        assert_eq!(slack.posts.lock().unwrap().len(), 1);
        let now = T0 + 10 * 30_000;
        second.tick(now, &fleet(now, true, true)).await;
        let posts = slack.posts.lock().unwrap().clone();
        assert_eq!(posts.len(), 2);
        assert_eq!(posts[1]["thread_ts"], "1791900000.000001");
        let third = Engine::load(config(&url, Some(path), true));
        assert!(third.view().active.is_empty());
        assert_eq!(third.view().recent.len(), 1);
    }

    /// Runs one tick until the fake Slack is blocked on a request, then aborts it like shutdown does.
    async fn interrupted_tick(slack: &FakeSlack, mut engine: Engine, now: i64, signals: Signals) {
        let task = tokio::spawn(async move { engine.tick(now, &signals).await });
        slack.blocked.notified().await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        *slack.block_from.lock().unwrap() = None;
    }
    fn clock_and_dispatch(synchronized: bool, last_trigger: Option<i64>) -> Signals {
        Signals {
            clock_synchronized: Some(synchronized),
            dispatch_last_trigger_ms: Some(last_trigger),
            ..Default::default()
        }
    }
    fn texts_containing(slack: &FakeSlack, needle: &str) -> usize {
        let posts = slack.posts.lock().unwrap();
        posts
            .iter()
            .filter(|p| p["text"].as_str().unwrap().contains(needle))
            .count()
    }

    #[tokio::test]
    async fn interrupted_open_delivery_keeps_the_acknowledged_ts() {
        let (slack, url) = fake_slack().await;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("alerts.json");
        // Two alerts open together: Slack acknowledges the first, the second hangs.
        *slack.block_from.lock().unwrap() = Some(2);
        let firing = clock_and_dispatch(false, None);
        let engine = Engine::load(config(&url, Some(path.clone()), true));
        interrupted_tick(&slack, engine, T0, firing.clone()).await;
        assert_eq!(slack.posts.lock().unwrap().len(), 1);
        assert!(texts_containing(&slack, "clock not NTP-synchronized") == 1);

        let mut restarted = Engine::load(config(&url, Some(path.clone()), true));
        let stored: Vec<_> = restarted
            .stored
            .active
            .iter()
            .map(|open| (open.key.as_str(), open.slack_ts.as_deref()))
            .collect();
        assert_eq!(
            stored,
            [
                ("clock:ntp", Some(posts_ts(1).as_str())),
                ("dispatch:timer", None)
            ]
        );
        restarted.tick(T0 + MIN, &firing).await;
        restarted.tick(T0 + 2 * MIN, &firing).await;
        assert_eq!(texts_containing(&slack, "clock not NTP-synchronized"), 1);
        assert_eq!(
            texts_containing(&slack, "factory-dispatch.timer has never fired"),
            1
        );
        restarted
            .tick(T0 + 3 * MIN, &clock_and_dispatch(true, Some(T0 + 3 * MIN)))
            .await;
        let posts = slack.posts.lock().unwrap().clone();
        assert_eq!(posts.len(), 4, "{posts:?}");
        assert_eq!(posts[2]["thread_ts"], posts_ts(1));
        assert!(posts[2]["text"].as_str().unwrap().contains("clock not NTP"));
        assert_eq!(posts[3]["thread_ts"], posts_ts(2));
        assert!(
            posts[3]["text"]
                .as_str()
                .unwrap()
                .contains("factory-dispatch.timer")
        );
    }

    #[tokio::test]
    async fn interrupted_recovery_delivery_keeps_the_acknowledged_recovery() {
        let (slack, url) = fake_slack().await;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("alerts.json");
        let mut engine = Engine::load(config(&url, Some(path.clone()), true));
        engine.tick(T0, &clock_and_dispatch(false, None)).await;
        assert_eq!(slack.posts.lock().unwrap().len(), 2);
        // Both clear: the first recovery is acknowledged, the second hangs.
        *slack.block_from.lock().unwrap() = Some(4);
        let cleared = clock_and_dispatch(true, Some(T0 + MIN));
        interrupted_tick(&slack, engine, T0 + MIN, cleared.clone()).await;
        assert_eq!(slack.posts.lock().unwrap().len(), 3);

        let mut restarted = Engine::load(config(&url, Some(path), true));
        assert!(restarted.stored.active.is_empty());
        assert_eq!(restarted.stored.outbox.len(), 1);
        assert_eq!(restarted.stored.outbox[0].thread_ts, Some(posts_ts(2)));
        restarted.tick(T0 + 2 * MIN, &cleared).await;
        restarted.tick(T0 + 3 * MIN, &cleared).await;
        let posts = slack.posts.lock().unwrap().clone();
        assert_eq!(posts.len(), 4, "{posts:?}");
        assert_eq!(posts[2]["thread_ts"], posts_ts(1));
        assert_eq!(posts[3]["thread_ts"], posts_ts(2));
        assert_eq!(texts_containing(&slack, "Recovered"), 2);
        assert_eq!(restarted.view().recent.len(), 2);
    }

    #[tokio::test]
    async fn service_needs_three_consecutive_failed_checks() {
        let (slack, url) = fake_slack().await;
        let mut engine = Engine::load(config(&url, None, true));
        let mut now = T0;
        // Two failures, a success, two failures: never three in a row.
        for ok in [false, false, true, false, false] {
            engine.tick(now, &fleet(now, true, ok)).await;
            // An engine tick without a new fleet collection must not count.
            engine.tick(now + 1, &fleet(now, true, ok)).await;
            now += 30_000;
        }
        assert!(slack.posts.lock().unwrap().is_empty());
        engine.tick(now, &fleet(now, true, false)).await;
        let posts = slack.posts.lock().unwrap().clone();
        assert_eq!(posts.len(), 1);
        assert_eq!(
            posts[0]["text"],
            format!(
                ":warning: factory-gpu/ollama-http failing for 3 consecutive checks: HTTP 503 Service Unavailable · {DASHBOARD_URL}"
            )
        );
        // Services on an offline node defer to the node alert.
        let mut engine = Engine::load(config(&url, None, false));
        for check in 0..6 {
            let now = T0 + check * 30_000;
            engine.tick(now, &fleet(now, false, true)).await;
        }
        assert!(engine.view().active.is_empty());
    }

    #[tokio::test]
    async fn missing_token_evaluates_but_posts_nothing() {
        let (slack, url) = fake_slack().await;
        let mut engine = Engine::load(config(&url, None, false));
        for minute in 0..=6 {
            let now = T0 + minute * MIN;
            engine.tick(now, &fleet(now, false, true)).await;
        }
        assert_eq!(engine.view().active.len(), 1);
        let now = T0 + 7 * MIN;
        engine.tick(now, &fleet(now, true, true)).await;
        assert_eq!(engine.view().recent.len(), 1);
        assert!(slack.posts.lock().unwrap().is_empty());
        assert!(engine.stored.outbox.is_empty());
    }

    #[tokio::test]
    async fn unavailable_source_logs_once_and_holds_open_alerts() {
        let (slack, url) = fake_slack().await;
        let mut engine = Engine::load(config(&url, None, true));
        let clock = |synchronized| Signals {
            clock_synchronized: synchronized,
            ..Default::default()
        };
        let first = engine.evaluate(T0, &clock(None));
        assert!(first.contains(&"clock") && first.contains(&"backup"));
        for minute in 1..5 {
            assert!(engine.evaluate(T0 + minute * MIN, &clock(None)).is_empty());
        }
        assert!(engine.view().active.is_empty());
        engine.tick(T0 + 5 * MIN, &clock(Some(false))).await;
        assert_eq!(engine.view().active[0].key, "clock:ntp");
        // Unreadable again: neither cleared nor reposted; logged once more.
        assert_eq!(engine.evaluate(T0 + 6 * MIN, &clock(None)), vec!["clock"]);
        engine.tick(T0 + 7 * MIN, &clock(None)).await;
        assert_eq!(engine.view().active.len(), 1);
        engine.tick(T0 + 8 * MIN, &clock(Some(true))).await;
        assert!(engine.view().active.is_empty());
        let posts = slack.posts.lock().unwrap().clone();
        assert_eq!(posts.len(), 2);
        assert_eq!(posts[1]["thread_ts"], posts_ts(1));
    }
    fn posts_ts(n: usize) -> String {
        format!("1791900000.{n:06}")
    }

    #[tokio::test]
    async fn failed_posts_retry_with_backoff_and_info_has_no_recovery() {
        let (slack, url) = fake_slack().await;
        *slack.fail.lock().unwrap() = 1;
        let mut engine = Engine::load(config(&url, None, true));
        let pending = |pending: Vec<(&str, &str)>| Signals {
            pricing_pending: Some(
                pending
                    .into_iter()
                    .map(|(f, m)| (f.into(), m.into()))
                    .collect(),
            ),
            ..Default::default()
        };
        let signals = pending(vec![("Claude Sonnet", "anthropic/claude-sonnet-5")]);
        engine.tick(T0, &signals).await;
        assert!(slack.posts.lock().unwrap().is_empty());
        engine.tick(T0 + 10_000, &signals).await; // backoff not elapsed
        assert!(slack.posts.lock().unwrap().is_empty());
        engine.tick(T0 + 30_000, &signals).await;
        let posts = slack.posts.lock().unwrap().clone();
        assert_eq!(posts.len(), 1);
        assert_eq!(
            posts[0]["text"],
            format!(
                ":information_source: pricing.changed: new Claude Sonnet reference model pending: anthropic/claude-sonnet-5 (confirm on the dashboard) · {DASHBOARD_URL}"
            )
        );
        engine.tick(T0 + 60_000, &pending(vec![])).await;
        assert_eq!(slack.posts.lock().unwrap().len(), 1);
        assert_eq!(engine.view().recent[0].severity, AlertSeverity::Info);
    }

    #[test]
    fn signal_rules() {
        let mut engine = Engine::load(Config::default());
        let keys = |engine: &Engine| {
            engine
                .view()
                .active
                .into_iter()
                .map(|a| (a.key, a.summary))
                .collect::<Vec<_>>()
        };
        // GPU: hot for under two minutes is held; a stale sample is unavailable.
        let gpu = |ts, t| Signals {
            gpu: Some((ts, t)),
            ..Default::default()
        };
        engine.evaluate(T0, &gpu(T0, 86.0));
        engine.evaluate(T0 + MIN, &gpu(T0 + MIN, 90.0));
        assert!(keys(&engine).is_empty());
        engine.evaluate(T0 + 2 * MIN, &gpu(T0 + 2 * MIN, 87.4));
        assert_eq!(
            keys(&engine),
            [(
                "gpu:temperature".into(),
                "GPU temperature 87 °C, above 85 °C for 2 min".into()
            )]
        );
        assert_eq!(
            engine.evaluate(T0 + 10 * MIN, &gpu(T0 + 7 * MIN, 20.0)),
            vec!["gpu"]
        );
        assert_eq!(keys(&engine).len(), 1);
        engine.evaluate(T0 + 11 * MIN, &gpu(T0 + 11 * MIN, 85.0));
        assert!(keys(&engine).is_empty());

        // Backup: stale > 36 h, failed, stuck pending; an in-progress run is fine.
        let backup = |entries: Vec<BackupRow>| Signals {
            backup: Some(
                entries
                    .into_iter()
                    .map(|(name, success, attempt, error)| BackupEntry {
                        name: name.into(),
                        last_success_ms: success,
                        last_attempt_ms: attempt,
                        error: error.map(str::to_owned),
                    })
                    .collect(),
            ),
            ..Default::default()
        };
        let h = 3_600_000;
        engine.evaluate(
            T0,
            &backup(vec![
                (
                    "meter",
                    Some(T0 - 35 * h),
                    Some(T0 - 10 * MIN),
                    Some("Peer push pending"),
                ),
                ("pricing", Some(T0 - 24 * h), Some(T0 - 24 * h), None),
            ]),
        );
        assert!(keys(&engine).is_empty());
        engine.evaluate(
            T0,
            &backup(vec![
                ("meter", Some(T0 - 37 * h), Some(T0 - 37 * h), None),
                (
                    "requests",
                    Some(T0 - 3 * h),
                    Some(T0 - 3 * h),
                    Some("Peer push pending"),
                ),
                (
                    "pricing",
                    Some(T0 - h),
                    Some(T0 - h),
                    Some("rsync: connection refused\n"),
                ),
            ]),
        );
        assert_eq!(
            keys(&engine),
            [("backup:status".into(), "backup: meter last succeeded 37 h ago; requests failed: Peer push pending; pricing failed: rsync: connection refused".into())]
        );

        // Dispatch timer and usage snapshot staleness.
        engine.evaluate(
            T0,
            &Signals {
                dispatch_last_trigger_ms: Some(Some(T0 - 5 * MIN)),
                usage: Some(vec![
                    ("amp".into(), Some(T0 - 45 * MIN)),
                    ("codex".into(), None),
                ]),
                ..Default::default()
            },
        );
        assert!(
            !keys(&engine)
                .iter()
                .any(|(k, _)| k.starts_with("dispatch") || k.starts_with("usage"))
        );
        engine.evaluate(
            T0,
            &Signals {
                dispatch_last_trigger_ms: Some(Some(T0 - 5 * MIN - 1)),
                usage: Some(vec![
                    ("amp".into(), Some(T0 - 45 * MIN - 1)),
                    ("claude-code".into(), Some(T0 - 3 * h)),
                ]),
                meter_synced_at_ms: Some(T0 - 6 * MIN),
                ..Default::default()
            },
        );
        let found = keys(&engine);
        assert!(found.contains(&(
            "dispatch:timer".into(),
            "factory-dispatch.timer last fired 5 min ago".into()
        )));
        assert!(found.contains(&(
            "usage:stale".into(),
            "usage snapshot stale: no good amp, claude-code reading for over 45 min".into()
        )));
        assert!(found.contains(&(
            "meter:sync".into(),
            "meter sync gap: no successful sync for 6 min".into()
        )));
    }

    #[test]
    fn retention_alerts_only_after_a_day_of_not_pruning() {
        let mut engine = Engine::load(Config::default());
        let h = 3_600_000;
        let retention = |status: &str, since: Option<i64>| crate::types::RequestRetention {
            status: status.into(),
            detail: since.map(|_| "rollup unverified: the request rollup has not passed".into()),
            skipped_since_ms: since,
            ..Default::default()
        };
        let signals = |api, meter| Signals {
            retention: vec![("api", Some(api)), ("meter", meter)],
            ..Default::default()
        };
        let active = |engine: &Engine| {
            engine
                .view()
                .active
                .into_iter()
                .map(|a| (a.key, a.summary))
                .collect::<Vec<_>>()
        };
        engine.evaluate(
            T0,
            &signals(
                retention("skipped", Some(T0 - 24 * h + 1)),
                Some(retention("ok", None)),
            ),
        );
        assert!(active(&engine).is_empty());
        engine.evaluate(
            T0,
            &signals(
                retention("ok", None),
                Some(retention("failed", Some(T0 - 26 * h))),
            ),
        );
        assert_eq!(
            active(&engine),
            [(
                "retention:meter".into(),
                "meter request retention not pruning for 26 h (failed): rollup unverified: the request rollup has not passed".into()
            )]
        );
        // An unreadable meter keeps the alert open; a pruning run clears it.
        engine.evaluate(T0 + h, &signals(retention("ok", None), None));
        assert_eq!(active(&engine).len(), 1);
        engine.evaluate(
            T0 + 2 * h,
            &signals(retention("ok", None), Some(retention("ok", None))),
        );
        assert!(active(&engine).is_empty());
    }

    #[test]
    fn source_parsers() {
        assert_eq!(
            parse_timer("LoadState=loaded\nLastTriggerUSec=@1791897724\n"),
            Some(Some(1_791_897_724_000))
        );
        assert_eq!(
            parse_timer("LastTriggerUSec=n/a\nLoadState=loaded\n"),
            Some(None)
        );
        assert_eq!(
            parse_timer("LoadState=not-found\nLastTriggerUSec=n/a\n"),
            None
        );
        assert_eq!(
            parse_timer("LoadState=loaded\nLastTriggerUSec=Mon 2026-10-13\n"),
            None
        );
        let status = br#"{"meter": {"last_success_ms": 5, "last_attempt_ms": 6, "size_bytes": 1,
            "integrity": "ok", "pushed_to_peer": true, "error": null}}"#;
        assert_eq!(
            parse_backup(status),
            Some(vec![BackupEntry {
                name: "meter".into(),
                last_success_ms: Some(5),
                last_attempt_ms: Some(6),
                error: None,
            }])
        );
        assert_eq!(parse_backup(br#"{"meter": 3}"#), None);
        assert_eq!(parse_backup(b"not json"), None);
        assert!(Token::new(" \n").is_none());
        assert!(Token::new("xoxb bad").is_none());
        assert_eq!(
            format!("{:?}", Token::new("xoxb-secret")),
            "Some(Token(redacted))"
        );
        assert!(slack_url("ftp://x").is_err());
        assert_eq!(
            slack_url("http://127.0.0.1:9/api/").unwrap(),
            "http://127.0.0.1:9/api"
        );
    }

    #[test]
    fn remote_device_alerts_are_per_device_and_defer_to_the_node_alert() {
        use crate::devices::{DeviceAlertInput, FsPressure};
        let mut engine = Engine::load(Config {
            state_path: None,
            channel: "C-test".into(),
            slack_url: "http://127.0.0.1:1/api".into(),
            token: None,
            ..Config::default()
        });
        let input = |at: i64, cpu: f64, space: f64| DeviceAlertInput {
            fast_success_ms: Some(at),
            cpu_temp_c: Some(Some(cpu)),
            filesystems: Some(vec![FsPressure {
                id: "root".into(),
                space_percent: Some(space),
                inode_percent: Some(10.0),
            }]),
            smart: Some(vec![]),
            unsafe_shutdowns: BTreeMap::new(),
        };
        let signals = |gpu: DeviceAlertInput,
                       console: DeviceAlertInput,
                       console_online: bool,
                       at: i64| Signals {
            devices: Some(gpu),
            remote_devices: vec![("factory-console".into(), console)],
            ..fleet(at, console_online, true)
        };
        let keys = |engine: &Engine| {
            let mut keys: Vec<_> = engine
                .view()
                .active
                .iter()
                .map(|open| (open.key.clone(), open.summary.clone()))
                .collect();
            keys.sort();
            keys
        };
        // A hot console does not touch factory-gpu keys, and the reverse.
        for at in [T0, T0 + 120_000] {
            engine.evaluate(
                at,
                &signals(input(at, 50.0, 10.0), input(at, 96.0, 96.0), true, at),
            );
        }
        assert_eq!(
            keys(&engine),
            vec![(
                "devices:factory-console:cpu:temperature:critical".to_string(),
                "factory-console: CPU temperature 96 C (critical 95 C)".to_string()
            )]
        );
        let at = T0 + 600_000;
        engine.evaluate(
            at,
            &signals(input(at, 50.0, 10.0), input(at, 50.0, 96.0), true, at),
        );
        let open: Vec<_> = keys(&engine).into_iter().map(|(key, _)| key).collect();
        assert_eq!(open, ["devices:factory-console:fs:root:space:critical",]);
        // The console stops sending: telemetry fires after 2 minutes for that device only.
        let last = at;
        let at = last + 120_000;
        engine.evaluate(
            at,
            &signals(input(at, 50.0, 10.0), input(last, 50.0, 10.0), true, at),
        );
        let open: Vec<_> = keys(&engine).into_iter().map(|(key, _)| key).collect();
        assert!(open.contains(&"devices:factory-console:telemetry".to_string()));
        assert!(!open.contains(&"devices:telemetry".to_string()));
        // Fleet reports the node offline: the node alert owns it, the open one holds.
        engine.evaluate(
            at + 30_000,
            &signals(
                input(at, 50.0, 10.0),
                input(last, 50.0, 10.0),
                false,
                at + 30_000,
            ),
        );
        let open: Vec<_> = keys(&engine).into_iter().map(|(key, _)| key).collect();
        assert!(open.contains(&"devices:factory-console:telemetry".to_string()));
        // Recovery clears it.
        let back = at + 60_000;
        engine.evaluate(
            back,
            &signals(input(back, 50.0, 10.0), input(back, 50.0, 10.0), true, back),
        );
        assert!(
            !keys(&engine)
                .iter()
                .any(|(key, _)| key.ends_with("telemetry"))
        );

        // A never-seen remote device that stays offline does not open telemetry beside node:… .
        let mut quiet = Engine::load(Config {
            state_path: None,
            channel: "C-test".into(),
            slack_url: "http://127.0.0.1:1/api".into(),
            token: None,
            ..Config::default()
        });
        for at in [T0, T0 + 130_000] {
            quiet.evaluate(
                at,
                &signals(
                    input(at, 50.0, 10.0),
                    DeviceAlertInput::default(),
                    false,
                    at,
                ),
            );
        }
        assert!(
            !keys(&quiet)
                .iter()
                .any(|(key, _)| key.starts_with("devices:"))
        );
        for at in [T0 + 140_000, T0 + 270_000] {
            quiet.evaluate(
                at,
                &signals(input(at, 50.0, 10.0), DeviceAlertInput::default(), true, at),
            );
        }
        assert!(
            keys(&quiet)
                .iter()
                .any(|(key, _)| key == "devices:factory-console:telemetry")
        );
    }

    #[test]
    fn device_alerts_debounce_hold_and_hysteresis() {
        use crate::devices::{DeviceAlertInput, FsPressure, SmartPressure};
        let mut engine = Engine::load(Config {
            state_path: None,
            channel: "C-test".into(),
            slack_url: "http://127.0.0.1:1/api".into(),
            token: None,
            ..Config::default()
        });
        let signals = |input: DeviceAlertInput| Signals {
            devices: Some(input),
            ..Default::default()
        };
        let fresh = |at: i64, cpu: Option<Option<f64>>, filesystems, smart| DeviceAlertInput {
            fast_success_ms: Some(at),
            cpu_temp_c: cpu,
            filesystems,
            smart,
            unsafe_shutdowns: BTreeMap::new(),
        };
        let quiet_fs = Some(vec![FsPressure {
            id: "root".into(),
            space_percent: Some(10.0),
            inode_percent: Some(10.0),
        }]);
        let quiet_smart = Some(vec![SmartPressure {
            id: "wwn-a".into(),
            unhealthy: Some(false),
        }]);
        let keys = |engine: &Engine| {
            engine
                .view()
                .active
                .iter()
                .map(|open| open.key.clone())
                .collect::<Vec<_>>()
        };
        engine.evaluate(
            T0,
            &signals(fresh(
                T0,
                Some(Some(70.0)),
                quiet_fs.clone(),
                quiet_smart.clone(),
            )),
        );
        assert!(keys(&engine).is_empty());
        engine.evaluate(T0, &signals(DeviceAlertInput::default()));
        assert!(keys(&engine).is_empty());
        engine.evaluate(T0 + 120_000, &signals(DeviceAlertInput::default()));
        assert_eq!(keys(&engine), vec!["devices:telemetry".to_string()]);
        engine.evaluate(T0 + 130_000, &Signals::default());
        assert_eq!(keys(&engine), vec!["devices:telemetry".to_string()]);
        engine.evaluate(
            T0 + 140_000,
            &signals(fresh(
                T0 + 140_000,
                Some(Some(70.0)),
                quiet_fs.clone(),
                quiet_smart.clone(),
            )),
        );
        assert!(keys(&engine).is_empty());

        let hot = fresh(
            T0 + 140_000,
            Some(Some(96.0)),
            quiet_fs.clone(),
            quiet_smart.clone(),
        );
        engine.evaluate(T0 + 140_000, &signals(hot));
        assert!(keys(&engine).iter().all(|key| !key.contains("temperature")));
        engine.evaluate(
            T0 + 260_000,
            &signals(fresh(
                T0 + 260_000,
                Some(Some(96.0)),
                quiet_fs.clone(),
                quiet_smart.clone(),
            )),
        );
        assert!(keys(&engine).contains(&"devices:cpu:temperature:critical".into()));
        engine.evaluate(
            T0 + 270_000,
            &signals(fresh(T0, None, None, quiet_smart.clone())),
        );
        let aged = keys(&engine);
        assert!(aged.contains(&"devices:telemetry".into()));
        assert!(aged.contains(&"devices:cpu:temperature:critical".into()));
        engine.evaluate(
            T0 + 280_000,
            &signals(fresh(
                T0 + 280_000,
                Some(Some(92.0)),
                quiet_fs.clone(),
                quiet_smart.clone(),
            )),
        );
        assert!(keys(&engine).contains(&"devices:cpu:temperature:critical".into()));
        assert!(!keys(&engine).contains(&"devices:telemetry".into()));
        engine.evaluate(
            T0 + 290_000,
            &signals(fresh(
                T0 + 290_000,
                Some(Some(82.0)),
                quiet_fs.clone(),
                quiet_smart.clone(),
            )),
        );
        assert!(!keys(&engine).iter().any(|key| key.contains("critical")));
        engine.evaluate(
            T0 + 290_000 + 5 * MIN,
            &signals(fresh(
                T0 + 290_000 + 5 * MIN,
                Some(Some(82.0)),
                quiet_fs.clone(),
                quiet_smart.clone(),
            )),
        );
        assert!(keys(&engine).contains(&"devices:cpu:temperature:warning".into()));
        engine.evaluate(
            T0 + 700_000,
            &signals(fresh(
                T0 + 700_000,
                Some(None),
                quiet_fs.clone(),
                quiet_smart.clone(),
            )),
        );
        assert!(keys(&engine).iter().all(|key| !key.contains("temperature")));

        let full = fresh(
            T0 + 700_000,
            Some(Some(70.0)),
            Some(vec![FsPressure {
                id: "root".into(),
                space_percent: Some(96.0),
                inode_percent: Some(96.0),
            }]),
            quiet_smart.clone(),
        );
        engine.evaluate(T0 + 700_000, &signals(full.clone()));
        assert!(keys(&engine).iter().all(|key| !key.contains("devices:fs:")));
        engine.evaluate(
            T0 + 700_000 + 10 * MIN,
            &signals(fresh(
                T0 + 700_000 + 10 * MIN,
                Some(Some(70.0)),
                full.filesystems.clone(),
                quiet_smart.clone(),
            )),
        );
        let pressure = keys(&engine);
        assert!(pressure.contains(&"devices:fs:root:space:critical".into()));
        assert!(pressure.contains(&"devices:fs:root:inodes:critical".into()));
        engine.evaluate(
            T0 + 700_000 + 11 * MIN,
            &signals(fresh(
                T0 + 700_000 + 11 * MIN,
                Some(Some(70.0)),
                None,
                quiet_smart.clone(),
            )),
        );
        assert!(keys(&engine).contains(&"devices:fs:root:space:critical".into()));

        let bad = fresh(
            T0 + 1_500_000,
            Some(Some(70.0)),
            quiet_fs.clone(),
            Some(vec![SmartPressure {
                id: "wwn-a".into(),
                unhealthy: Some(true),
            }]),
        );
        engine.evaluate(T0 + 1_500_000, &signals(bad.clone()));
        assert!(keys(&engine).iter().all(|key| !key.contains("smart")));
        engine.evaluate(
            T0 + 1_560_000,
            &signals(fresh(
                T0 + 1_560_000,
                Some(Some(70.0)),
                quiet_fs.clone(),
                bad.smart.clone(),
            )),
        );
        assert!(keys(&engine).contains(&"devices:smart:wwn-a".into()));
        engine.evaluate(
            T0 + 1_570_000,
            &signals(fresh(
                T0 + 1_570_000,
                Some(Some(70.0)),
                quiet_fs.clone(),
                quiet_smart.clone(),
            )),
        );
        assert!(keys(&engine).contains(&"devices:smart:wwn-a".into()));
        engine.evaluate(
            T0 + 1_690_000,
            &signals(fresh(
                T0 + 1_690_000,
                Some(Some(70.0)),
                quiet_fs,
                quiet_smart,
            )),
        );
        assert!(keys(&engine).iter().all(|key| !key.contains("smart")));
    }

    fn network_event(state: LinkState, started_ms: i64) -> NetworkEvent {
        NetworkEvent {
            id: 1,
            state,
            started_ms,
            ended_ms: None,
            end_reason: None,
            peak_loss_percent: Some(100.0),
            peak_rtt_us: None,
            peak_mdev_us: None,
        }
    }
    fn network(input: NetworkAlertInput) -> Signals {
        Signals {
            network: Some(input),
            ..Default::default()
        }
    }
    fn open_network(state: LinkState, started_ms: i64) -> Signals {
        network(NetworkAlertInput {
            open_event: Some(network_event(state, started_ms)),
            ..Default::default()
        })
    }
    fn active(engine: &Engine) -> Vec<(String, AlertSeverity, String, i64)> {
        engine
            .view()
            .active
            .into_iter()
            .map(|a| (a.key, a.severity, a.summary, a.opened_at_ms))
            .collect()
    }

    #[test]
    fn network_down_alerts_open_after_two_minutes_and_clear_when_the_event_ends() {
        let mut engine = Engine::load(Config::default());
        let wan = LinkState::Down { layer: Layer::Wan };
        engine.evaluate(T0 + 119_000, &open_network(wan, T0));
        assert!(active(&engine).is_empty(), "119 s is not yet 2 min");
        engine.evaluate(T0 + 120_000, &open_network(wan, T0));
        let opened = vec![(
            "network:wan_down".to_string(),
            AlertSeverity::Critical,
            "network wan down for 2 min: ISP outage, every wan target lost; peak loss 100%"
                .to_string(),
            T0 + 120_000,
        )];
        assert_eq!(active(&engine), opened);
        engine.evaluate(T0 + 10 * MIN, &open_network(wan, T0));
        assert_eq!(active(&engine), opened);
        // A newer down episode (the last one ended between reads) is younger
        // than 2 min: it holds the alert instead of clearing or reposting it.
        engine.evaluate(T0 + 11 * MIN, &open_network(wan, T0 + 11 * MIN));
        assert_eq!(active(&engine), opened);
        // Down changing to degraded ends the condition.
        let degraded = LinkState::Degraded {
            layer: Layer::Wan,
            reason: crate::network_diagnosis::Reason::Loss,
        };
        engine.evaluate(T0 + 12 * MIN, &open_network(degraded, T0 + 12 * MIN));
        assert!(active(&engine).is_empty());
        assert_eq!(engine.view().recent[0].key, "network:wan_down");
        for (layer, key, summary) in [
            (
                Layer::Lan,
                "network:lan_down",
                "network lan down for 5 min: gateway unreachable; peak loss 100%",
            ),
            (
                Layer::Dns,
                "network:dns_down",
                "network dns down for 5 min: name resolution failing; peak loss 100%",
            ),
        ] {
            let down = LinkState::Down { layer };
            let at = T0 + 20 * MIN;
            engine.evaluate(at + 119_000, &open_network(down, at));
            assert!(active(&engine).is_empty(), "{key}");
            engine.evaluate(at + 5 * MIN, &open_network(down, at));
            assert_eq!(
                active(&engine),
                [(
                    key.into(),
                    AlertSeverity::Critical,
                    summary.into(),
                    at + 5 * MIN
                )]
            );
            // The event closed: no open event, nothing held.
            engine.evaluate(at + 6 * MIN, &network(NetworkAlertInput::default()));
            assert!(active(&engine).is_empty(), "{key}");
        }
        // A change of layer clears the old key and starts the new one's 2 minutes.
        let lan = LinkState::Down { layer: Layer::Lan };
        engine.evaluate(T0 + 40 * MIN, &open_network(wan, T0 + 30 * MIN));
        engine.evaluate(T0 + 41 * MIN, &open_network(lan, T0 + 41 * MIN));
        assert!(active(&engine).is_empty());
        // tailnet has no alert in v1, however long it is down.
        let tailnet = LinkState::Down {
            layer: Layer::Tailnet,
        };
        engine.evaluate(T0 + 120 * MIN, &open_network(tailnet, T0 + 50 * MIN));
        assert!(active(&engine).is_empty());
        // Peaks with replies appear in the summary.
        let mut event = network_event(degraded, T0);
        event.state = LinkState::Down { layer: Layer::Dns };
        event.peak_loss_percent = Some(100.0);
        event.peak_rtt_us = Some(12_345);
        event.peak_mdev_us = Some(1_500);
        engine.evaluate(
            T0 + 3 * MIN,
            &network(NetworkAlertInput {
                open_event: Some(event),
                ..Default::default()
            }),
        );
        assert_eq!(
            active(&engine)[0].2,
            "network dns down for 3 min: name resolution failing; peak loss 100%, peak RTT 12.3 ms, peak jitter 1.5 ms"
        );
    }

    #[test]
    fn unreadable_network_storage_holds_open_alerts() {
        let mut engine = Engine::load(Config::default());
        let wan = LinkState::Down { layer: Layer::Wan };
        engine.evaluate(T0 + 120_000, &open_network(wan, T0));
        assert_eq!(active(&engine).len(), 1);
        let unreadable = Signals::default();
        assert!(
            engine
                .evaluate(T0 + 150_000, &unreadable)
                .contains(&"network")
        );
        assert!(
            !engine
                .evaluate(T0 + 180_000, &unreadable)
                .contains(&"network")
        );
        assert_eq!(active(&engine).len(), 1);
        engine.evaluate(T0 + 210_000, &network(NetworkAlertInput::default()));
        assert!(active(&engine).is_empty());
    }

    fn speed(id: i64, rates: Option<(i64, i64)>, error: Option<&str>) -> NetworkSpeedTest {
        NetworkSpeedTest {
            id,
            started_ms: id,
            ended_ms: id,
            outcome: match (rates, error) {
                (Some(_), _) => NetworkSpeedOutcome::Ok,
                (None, Some(_)) => NetworkSpeedOutcome::Failed,
                (None, None) => NetworkSpeedOutcome::Timeout,
            },
            error: error.map(str::to_owned),
            download_bps: rates.map(|r| r.0),
            upload_bps: rates.map(|r| r.1),
            download_bytes: 0,
            upload_bytes: 0,
            idle_latency_ms: None,
            download_loaded_latency_ms: None,
            upload_loaded_latency_ms: None,
            colo: None,
        }
    }

    #[test]
    fn throughput_low_needs_three_slow_ok_tests_and_one_fast_test_to_clear() {
        let mut engine = Engine::load(Config::default());
        const M: i64 = 1_000_000;
        let ok = |rates: &[(i64, i64)]| {
            network(NetworkAlertInput {
                recent_ok_tests: rates
                    .iter()
                    .map(|&(down, up)| speed(1, Some((down, up)), None))
                    .collect(),
                ..Default::default()
            })
        };
        let key = "network:throughput_low";
        let open = |engine: &Engine| active(engine).iter().any(|a| a.0 == key);
        for rates in [
            vec![(404 * M, 940 * M), (938 * M, 404 * M)],
            vec![(404 * M, 940 * M), (938 * M, 404 * M), (500 * M, 500 * M)],
            vec![(500 * M, 940 * M), (938 * M, 404 * M), (400 * M, 400 * M)],
        ] {
            engine.evaluate(T0, &ok(&rates));
            assert!(!open(&engine), "{rates:?}");
        }
        engine.evaluate(
            T0,
            &ok(&[
                (404 * M, 940 * M),
                (938 * M, 404 * M),
                (500 * M - 1, 600 * M),
            ]),
        );
        assert_eq!(
            active(&engine),
            [(
                key.into(),
                AlertSeverity::Warning,
                "network throughput below 500 Mb/s in the last 3 ok speed tests: download 404, 938, 500 Mb/s; upload 940, 404, 600 Mb/s".into(),
                T0
            )]
        );
        // A newer slow test, even after a fast one, cannot prove recovery.
        engine.evaluate(T0 + MIN, &ok(&[(450 * M, 940 * M), (940 * M, 940 * M)]));
        assert!(open(&engine));
        // Exactly at the floor both ways is not low.
        engine.evaluate(T0 + 2 * MIN, &ok(&[(500 * M, 500 * M), (450 * M, 450 * M)]));
        assert!(!open(&engine));
        // The floor is configuration.
        let mut strict = Engine::load(Config {
            network_throughput_low_bps: 950 * M,
            ..Config::default()
        });
        strict.evaluate(T0, &ok(&[(940 * M, 940 * M); 3]));
        assert_eq!(active(&strict)[0].0, key);
        assert!(
            active(&strict)[0]
                .2
                .starts_with("network throughput below 950 Mb/s")
        );
    }

    #[test]
    fn speedtest_failing_needs_three_unfinished_tests_and_clears_on_an_ok_test() {
        let mut engine = Engine::load(Config::default());
        let recent = |tests: Vec<NetworkSpeedTest>| {
            network(NetworkAlertInput {
                recent_tests: tests,
                ..Default::default()
            })
        };
        let failed = |id| speed(id, None, Some("download of 10000000 bytes: HTTP 500"));
        let timeout = |id| speed(id, None, None);
        let fine = |id| speed(id, Some((900_000_000, 900_000_000)), None);
        let key = "network:speedtest_failing";
        let open = |engine: &Engine| active(engine).iter().any(|a| a.0 == key);
        for tests in [
            vec![failed(3), timeout(2)],
            vec![failed(3), timeout(2), fine(1)],
        ] {
            engine.evaluate(T0, &recent(tests));
            assert!(!open(&engine));
        }
        engine.evaluate(T0, &recent(vec![failed(3), timeout(2), failed(1)]));
        assert_eq!(
            active(&engine),
            [(
                key.into(),
                AlertSeverity::Warning,
                "network speed test failing: the last 3 tests did not finish: failed: download of 10000000 bytes: HTTP 500; timeout; failed: download of 10000000 bytes: HTTP 500".into(),
                T0
            )]
        );
        // Still failing, with an older ok test in the window: held, not cleared.
        engine.evaluate(T0 + MIN, &recent(vec![timeout(5), fine(4), failed(3)]));
        assert!(open(&engine));
        engine.evaluate(T0 + 2 * MIN, &recent(vec![fine(6), timeout(5), failed(3)]));
        assert!(!open(&engine));
    }
}
