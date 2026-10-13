//! Slack alerts for signals factory-api already has (MET-150).
//!
//! Every 30 s the engine turns current signals into per-key verdicts, posts one
//! Slack message when a key opens and a threaded recovery when it clears. State
//! lives in a small JSON file (never SQLite) so restarts do not repost. A source
//! that cannot be read is logged once as unavailable and never alerts; its open
//! alerts are held until it is readable again. Never log the Slack token.
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
pub const DEFAULT_BACKUP_STATUS: &str = "/var/lib/factory-backup/status.json";
pub const DASHBOARD_URL: &str = "https://factory-gpu.bearded-pompano.ts.net";
/// systemd credential name; the unit loads it with `LoadCredential=`.
pub const TOKEN_CREDENTIAL: &str = "slack-bot-token";
pub const INTERVAL: Duration = Duration::from_secs(30);

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
/// factory-backup.service TimeoutStartSec: in-run "pending" markers older than this are stuck.
const BACKUP_RUN_MS: i64 = 2 * 3_600_000;
const DISPATCH_STALE_MS: i64 = 5 * 60_000;
/// Three 15-minute usage collector intervals.
const USAGE_STALE_MS: i64 = crate::usage::STALE_MS;
const MAX_BACKOFF_MS: i64 = 15 * 60_000;
const MAX_RECOVERY_ATTEMPTS: u32 = 12;
const SOURCES: [&str; 9] = [
    "node", "service", "gpu", "meter", "pricing", "backup", "clock", "dispatch", "usage",
];

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
}
impl Default for Config {
    fn default() -> Self {
        Self {
            state_path: None,
            channel: DEFAULT_CHANNEL.into(),
            slack_url: DEFAULT_SLACK_URL.into(),
            token: None,
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
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Recovery {
    key: String,
    thread_ts: String,
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
    /// Recovery replies not yet accepted by Slack.
    outbox: Vec<Recovery>,
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
        // Opens and clears (with their queued recoveries) are durable before any Slack call.
        self.persist();
        self.deliver(now).await;
        self.persist();
    }
    /// Applies one evaluation; returns sources newly reported unavailable.
    pub fn evaluate(&mut self, now: i64, signals: &Signals) -> Vec<&'static str> {
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
                    self.reconcile(source, now, findings);
                }
            }
        }
        newly
    }
    fn held(&mut self, key: &str, now: i64, hold_ms: i64) -> bool {
        let since = *self.pending_since.entry(key.into()).or_insert(now);
        now - since >= hold_ms
    }
    fn findings(&mut self, source: &str, now: i64, signals: &Signals) -> Option<Findings> {
        let mut out = Findings::new();
        match source {
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
    fn reconcile(&mut self, source: &str, now: i64, findings: Findings) {
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
                self.stored.active.push(Open {
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
            self.stored.outbox.push(Recovery {
                key: open.key.clone(),
                thread_ts,
                text: recovery_text(&open.summary, now - open.opened_at_ms),
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
            if recovery.next_post_ms > now {
                index += 1;
                continue;
            }
            let (thread_ts, text) = (recovery.thread_ts.clone(), recovery.text.clone());
            let result = post(&self.client, &self.config, &token, Some(&thread_ts), &text).await;
            let recovery = &mut self.stored.outbox[index];
            match result {
                Ok(_) => {
                    self.stored.outbox.remove(index);
                }
                Err(error) => {
                    recovery.attempts += 1;
                    if recovery.attempts >= MAX_RECOVERY_ATTEMPTS {
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
        let (backup, clock_synchronized, dispatch_last_trigger_ms, pricing_pending, usage) = tokio::join!(
            backup,
            clock,
            dispatch,
            pricing,
            crate::usage::observations(&self.usage_snapshot, now)
        );
        Signals {
            fleet: (fleet.generated_at_ms != 0).then_some(fleet),
            fleet_discovered: self.fleet_discovered.load(Ordering::Acquire),
            gpu: *self.gpu_latest.lock().expect("GPU sample lock"),
            meter_synced_at_ms: Some(self.meter_synced_at_ms.load(Ordering::Acquire)),
            pricing_pending,
            backup,
            clock_synchronized,
            dispatch_last_trigger_ms,
            usage,
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
            // The first tick waits one interval so fleet and GPU collectors have run.
            let mut timer =
                tokio::time::interval_at(tokio::time::Instant::now() + INTERVAL, INTERVAL);
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! { biased;
                    _ = state.shutdown.cancelled() => break,
                    _ = timer.tick() => (),
                }
                state.query_scope = factory_db::Scope::default();
                let work = async {
                    let signals = state.alert_signals().await;
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
        assert_eq!(restarted.stored.outbox[0].thread_ts, posts_ts(2));
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
}
