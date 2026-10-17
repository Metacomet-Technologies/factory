//! factory-console telemetry agent (docs/devices-ingest.md, "Agent upload rules").
//!
//! Collection is factory-api's phase-1 collector (`devices::sample_timeout`), run
//! against this host. The agent adds the v1 contract identity, marks unpublished
//! status files unsupported, keeps every value inside the contract so one bad
//! sensor cannot get a whole sample rejected, and uploads one sample at a time.
//! It is read-only: no commands, writes, self-tests or remediation.
use factory_api::devices::{self, Availability, ClockView, Drive, Filesystem, Metric, NamedMetric};
use factory_api::devices_ingest::{self, DeviceSampleV1, SampleAgent, SampleMaintenance};
use std::{
    collections::{BTreeSet, HashMap, VecDeque},
    fmt, fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

pub const DEVICE_ID: &str = "factory-console";
pub const AGENT_NAME: &str = "factory-devices-agent";
pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const BUFFER_CAP: usize = 240;
pub const BACKUP_STATUS: &str = "var/lib/factory-backup-status/status.json";
pub const REBOOT_STATUS: &str = "var/lib/factory-reboot-status/status.json";
const MAX_TEXT: usize = 256;
const MAX_INT: f64 = 9_007_199_254_740_991.0;

/// Contract timings. Tests shorten them; production uses `Default`.
#[derive(Debug, Clone)]
pub struct Timing {
    pub fast: Duration,
    pub attempt_timeout: Duration,
    pub backoff_min: Duration,
    pub backoff_max: Duration,
    pub auth_retry: Duration,
    pub auth_log: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            fast: Duration::from_millis(devices::FAST_INTERVAL_MS as u64),
            attempt_timeout: Duration::from_secs(5),
            backoff_min: Duration::from_secs(1),
            backoff_max: Duration::from_secs(60),
            auth_retry: Duration::from_secs(300),
            auth_log: Duration::from_secs(3600),
        }
    }
}

/// The bearer credential. Debug and Display never show it.
#[derive(Clone)]
pub struct Token(String);

impl Token {
    /// `fdv1_` plus 43 base64url characters; surrounding whitespace is ignored.
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let body = text.strip_prefix("fdv1_")?;
        (body.len() == 43
            && body
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
        .then(|| Self(text.to_string()))
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(redacted)")
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// Random v4 UUID from the kernel CSPRNG.
pub fn new_session_id() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    let filled = unsafe { libc::getrandom(bytes.as_mut_ptr().cast(), bytes.len(), 0) };
    if filled != bytes.len() as isize {
        return Err(io::Error::last_os_error());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

/// Kernel NTP state, as `timedatectl`'s NTPSynchronized: a read-only adjtimex.
/// `None` when the call fails, for example under a seccomp `@clock` filter.
pub fn clock_synchronized() -> Option<bool> {
    let mut tx: libc::timex = unsafe { std::mem::zeroed() };
    if unsafe { libc::adjtimex(&mut tx) } < 0 {
        return None;
    }
    Some(tx.status & libc::STA_UNSYNC == 0)
}

/// Where readings come from. Tests use a fixture root and a fake clock.
pub struct Sources {
    pub root: PathBuf,
    pub clock: fn() -> Option<bool>,
    pub probe_timeout: Duration,
}

impl Sources {
    pub fn host(root: PathBuf) -> Self {
        Self {
            root,
            clock: clock_synchronized,
            probe_timeout: Duration::from_secs(1),
        }
    }
}

/// One agent process: a session and its sequence counter.
pub struct Collector {
    sampler: devices::Sampler,
    sources: Sources,
    session_id: String,
    seq: i64,
}

impl Collector {
    pub fn new(sources: Sources, session_id: String) -> Self {
        Self {
            sampler: devices::Sampler::default(),
            sources,
            session_id,
            seq: 0,
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Take one fast sample (and slow inventory when due). Never fails: every
    /// broken source is encoded on its own metric.
    pub fn sample(&mut self, now: i64) -> DeviceSampleV1 {
        let root = self.sources.root.clone();
        let clock = (self.sources.clock)();
        let backup_path = root.join(BACKUP_STATUS);
        let reboot_path = root.join(REBOOT_STATUS);
        let inputs = devices::Inputs {
            now_ms: now,
            gpu: None,
            ups: None,
            services: vec![],
            backup_path: backup_path.clone(),
            reboot_path: reboot_path.clone(),
            clock_synchronized: clock == Some(true),
        };
        let host = devices::sample_timeout(
            &root,
            &mut self.sampler,
            &inputs,
            self.sources.probe_timeout,
        )
        .device;
        self.seq += 1;
        let mut maintenance = SampleMaintenance {
            backup: host.maintenance.backup,
            clock: host.maintenance.clock,
            reboot: host.maintenance.reboot,
        };
        if clock.is_none() {
            maintenance.clock = ClockView {
                synchronized: None,
                availability: Availability::Error,
                observed_at_ms: now,
            };
        }
        // No published file on this node is "unsupported", not a fault.
        if absent(&backup_path) {
            maintenance.backup.availability = Availability::Unsupported;
        }
        if absent(&reboot_path) {
            maintenance.reboot.availability = Availability::Unsupported;
            maintenance.reboot.detail = Some("no published reboot status".into());
        }
        let mut sample = DeviceSampleV1 {
            schema_version: 1,
            device_id: DEVICE_ID.into(),
            agent: SampleAgent {
                name: AGENT_NAME.into(),
                version: AGENT_VERSION.into(),
            },
            session_id: self.session_id.clone(),
            seq: self.seq,
            observed_at_ms: now,
            sent_at_ms: now,
            identity: host.identity,
            cpu: host.cpu,
            memory: host.memory,
            filesystems: visible(&root, host.filesystems),
            drives: host.drives,
            disk_io: host.disk_io,
            network: host.network,
            cooling: host.cooling,
            maintenance,
            collector: host.collector,
        };
        conform(&mut sample);
        sample
    }
}

/// Only a missing path is absent. An unreadable parent is permission_denied,
/// which phase 1 already reports.
fn absent(path: &Path) -> bool {
    matches!(fs::symlink_metadata(path), Err(e) if e.kind() == io::ErrorKind::NotFound)
}

fn unescape(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\\'
            && index + 3 < bytes.len()
            && let Ok(code) = u8::from_str_radix(&value[index + 1..index + 4], 8)
        {
            out.push(code);
            index += 4;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Drop filesystems this process cannot really see: the unit's own PrivateTmp
/// binds (`/tmp`, `/var/tmp` from `systemd-private-*`) and mountpoints covered
/// by a later mount (ProtectHome's inaccessible /home), whose statvfs would
/// describe the covering mount. Without mountinfo the list is unchanged.
fn visible(root: &Path, filesystems: Vec<Filesystem>) -> Vec<Filesystem> {
    let Ok(text) = fs::read_to_string(root.join("proc/self/mountinfo")) else {
        return filesystems;
    };
    let mut top: HashMap<String, (String, String, String)> = HashMap::new();
    for line in text.lines() {
        let Some((pre, post)) = line.split_once(" - ") else {
            continue;
        };
        let pre: Vec<_> = pre.split_whitespace().collect();
        let post: Vec<_> = post.split_whitespace().collect();
        if pre.len() < 5 || post.len() < 2 {
            continue;
        }
        top.insert(
            unescape(pre[4]),
            (unescape(pre[3]), post[0].to_string(), unescape(post[1])),
        );
    }
    filesystems
        .into_iter()
        .filter(|fs| {
            top.get(&fs.mountpoint)
                .is_some_and(|(root, fstype, source)| {
                    !root.contains("/systemd-private-")
                        && *fstype == fs.fstype
                        && *source == fs.source
                })
        })
        .collect()
}

fn clip(text: &mut String) {
    if text.len() > MAX_TEXT {
        let mut end = MAX_TEXT;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
}

fn clip_opt(text: &mut Option<String>) {
    if let Some(text) = text {
        clip(text);
    }
}

/// Inclusive range and integer requirement per unit, as the server checks.
fn bounds(unit: &str) -> (f64, f64, bool) {
    match unit {
        "%" => (0.0, 100.0, false),
        "C" => (-40.0, 150.0, false),
        "bytes" | "count" => (0.0, MAX_INT, true),
        "B/s" => (0.0, 1e12, false),
        "rpm" => (0.0, 30_000.0, false),
        _ => (0.0, f64::MAX, false),
    }
}

fn conform_metric(metric: &mut Metric, sample_at: i64) {
    metric.observed_at_ms = metric.observed_at_ms.min(sample_at);
    clip_opt(&mut metric.detail);
    if metric.availability != Availability::Available {
        metric.value = None;
        return;
    }
    let (low, high, whole) = bounds(&metric.unit);
    let problem = match metric.value {
        None => Some("value missing".to_string()),
        Some(v) if !v.is_finite() => Some("value is not finite".to_string()),
        Some(v) if v < low || v > high => Some(format!("value {v} outside the contract range")),
        Some(v) if whole && v.fract() != 0.0 => Some(format!("value {v} is not an integer")),
        Some(_) => None,
    };
    if let Some(problem) = problem {
        metric.availability = Availability::Error;
        metric.value = None;
        metric.detail = Some(problem);
        clip_opt(&mut metric.detail);
    }
}

/// Unique names: a repeated sensor name gets ` #2`, ` #3`, ...
fn unique_names(items: &mut [NamedMetric]) {
    let mut seen = BTreeSet::new();
    for item in items.iter_mut() {
        clip(&mut item.name);
        if !seen.insert(item.name.clone()) {
            let base = item.name.clone();
            let mut n = 2;
            loop {
                let mut candidate = format!("{base} #{n}");
                clip(&mut candidate);
                if seen.insert(candidate.clone()) {
                    item.name = candidate;
                    break;
                }
                n += 1;
            }
        }
    }
}

/// Every `Metric` in a sample with its contract path.
pub fn metrics_mut(sample: &mut DeviceSampleV1) -> Vec<(String, &mut Metric)> {
    let mut out: Vec<(String, &mut Metric)> =
        vec![("identity.uptime".into(), &mut sample.identity.uptime)];
    let cpu = &mut sample.cpu;
    out.push(("cpu.utilization".into(), &mut cpu.utilization));
    out.push(("cpu.iowait".into(), &mut cpu.iowait));
    out.push(("cpu.load1".into(), &mut cpu.load1));
    out.push(("cpu.load5".into(), &mut cpu.load5));
    out.push(("cpu.load15".into(), &mut cpu.load15));
    out.push(("cpu.temperature".into(), &mut cpu.temperature));
    let ram = &mut sample.memory;
    out.push(("memory.total".into(), &mut ram.total));
    out.push(("memory.available".into(), &mut ram.available));
    out.push(("memory.used".into(), &mut ram.used));
    out.push(("memory.swap_total".into(), &mut ram.swap_total));
    out.push(("memory.swap_free".into(), &mut ram.swap_free));
    for fs in &mut sample.filesystems {
        let at = format!("filesystems[{}]", fs.mountpoint);
        out.push((format!("{at}.size"), &mut fs.size));
        out.push((format!("{at}.used"), &mut fs.used));
        out.push((format!("{at}.used_percent"), &mut fs.used_percent));
        out.push((
            format!("{at}.inodes_used_percent"),
            &mut fs.inodes_used_percent,
        ));
    }
    for drive in &mut sample.drives {
        let at = format!("drives[{}]", drive.kernel);
        out.push((format!("{at}.size"), &mut drive.size));
        out.push((format!("{at}.available_spare"), &mut drive.available_spare));
        out.push((format!("{at}.media_errors"), &mut drive.media_errors));
        out.push((format!("{at}.temperature"), &mut drive.temperature));
    }
    out.push(("disk_io.read".into(), &mut sample.disk_io.read));
    out.push(("disk_io.write".into(), &mut sample.disk_io.write));
    out.push(("network.rx".into(), &mut sample.network.rx));
    out.push(("network.tx".into(), &mut sample.network.tx));
    for item in &mut sample.cooling.temperatures {
        out.push((
            format!("cooling.temperatures[{}]", item.name),
            &mut item.metric,
        ));
    }
    for item in &mut sample.cooling.fans {
        out.push((format!("cooling.fans[{}]", item.name), &mut item.metric));
    }
    out
}

/// Keep a sample inside the v1 contract without discarding good readings: a
/// value the server would reject becomes `error` on that metric only.
pub fn conform(sample: &mut DeviceSampleV1) {
    let at = sample.observed_at_ms;
    clip_opt(&mut sample.identity.hostname);
    clip_opt(&mut sample.identity.boot_id);
    let mut ids = BTreeSet::new();
    sample.filesystems.retain_mut(|fs| {
        for text in [
            &mut fs.id,
            &mut fs.source,
            &mut fs.mountpoint,
            &mut fs.fstype,
        ] {
            clip(text);
        }
        ids.insert(fs.id.clone())
    });
    sample.filesystems.truncate(32);
    let mut ids = BTreeSet::new();
    sample.drives.retain_mut(|drive: &mut Drive| {
        clip(&mut drive.id);
        clip(&mut drive.kernel);
        clip_opt(&mut drive.model);
        ids.insert(drive.id.clone())
    });
    sample.drives.truncate(16);
    for drive in &mut sample.drives {
        drive.smart.observed_at_ms = drive.smart.observed_at_ms.min(at);
        clip_opt(&mut drive.smart.detail);
        if drive.smart.availability != Availability::Available {
            drive.smart.passed = None;
        }
        drive.spare_threshold_percent = drive
            .spare_threshold_percent
            .filter(|v| (0.0..=100.0).contains(v));
        // Not in schema version 1.
        drive.unsafe_shutdowns = None;
    }
    sample.cooling.temperatures.truncate(64);
    sample.cooling.fans.truncate(16);
    unique_names(&mut sample.cooling.temperatures);
    unique_names(&mut sample.cooling.fans);
    for (_, metric) in metrics_mut(sample) {
        conform_metric(metric, at);
    }
    let m = &mut sample.maintenance;
    m.backup.observed_at_ms = m.backup.observed_at_ms.min(at);
    clip_opt(&mut m.backup.error);
    if m.backup.availability != Availability::Available {
        m.backup.last_success_ms = None;
        m.backup.last_attempt_ms = None;
        m.backup.error = None;
    }
    m.clock.observed_at_ms = m.clock.observed_at_ms.min(at);
    if m.clock.availability != Availability::Available {
        m.clock.synchronized = None;
    }
    clip_opt(&mut m.reboot.detail);
    clip_opt(&mut m.reboot.last_decision);
    if m.reboot.availability != Availability::Available {
        let r = &mut m.reboot;
        r.reboot_required = None;
        r.pending_since_ms = None;
        r.days_pending = None;
        r.consecutive_skips = None;
        r.alert_due = None;
        r.last_check_ms = None;
        r.last_decision = None;
    }
    clip_opt(&mut sample.collector.detail);
}

/// What this host exposes: one row per source, `(path, availability, detail)`.
pub fn capabilities(sample: &mut DeviceSampleV1) -> Vec<(String, Availability, Option<String>)> {
    let mut rows = vec![
        (
            "collector.filesystems".to_string(),
            sample.collector.filesystems,
            None,
        ),
        ("collector.drives".into(), sample.collector.drives, None),
        ("collector.smart".into(), sample.collector.smart, None),
        (
            "cooling.temperatures".into(),
            sample.cooling.temperatures_availability,
            None,
        ),
        (
            "cooling.fans".into(),
            sample.cooling.fans_availability,
            None,
        ),
        (
            "maintenance.backup".into(),
            sample.maintenance.backup.availability,
            None,
        ),
        (
            "maintenance.clock".into(),
            sample.maintenance.clock.availability,
            None,
        ),
        (
            "maintenance.reboot".into(),
            sample.maintenance.reboot.availability,
            sample.maintenance.reboot.detail.clone(),
        ),
    ];
    for drive in &sample.drives {
        rows.push((
            format!("drives[{}].smart", drive.kernel),
            drive.smart.availability,
            drive.smart.detail.clone(),
        ));
    }
    for (path, metric) in metrics_mut(sample) {
        rows.push((path, metric.availability, metric.detail.clone()));
    }
    rows
}

/// Bounded in-memory queue, oldest first. When full the oldest is dropped.
pub struct Buffer {
    items: VecDeque<DeviceSampleV1>,
    cap: usize,
    pub evicted: u64,
}

impl Buffer {
    pub fn new(cap: usize) -> Self {
        Self {
            items: VecDeque::with_capacity(cap),
            cap,
            evicted: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Returns true when the oldest sample was dropped to make room.
    pub fn push(&mut self, sample: DeviceSampleV1) -> bool {
        let evict = self.items.len() >= self.cap;
        if evict {
            self.items.pop_front();
            self.evicted += 1;
        }
        self.items.push_back(sample);
        evict
    }

    /// The oldest sample's seq and request body, with `sent_at_ms` set for
    /// this attempt. A retry is the same sample; only `sent_at_ms` changes.
    pub fn next_body(&mut self, sent_at_ms: i64) -> Option<(i64, Vec<u8>)> {
        let front = self.items.front_mut()?;
        front.sent_at_ms = sent_at_ms.max(front.observed_at_ms);
        let body = serde_json::to_vec(front).expect("sample serializes");
        Some((front.seq, body))
    }

    /// Remove the oldest sample if it is still `seq` (it may have been evicted).
    pub fn done(&mut self, seq: i64) {
        if self.items.front().is_some_and(|s| s.seq == seq) {
            self.items.pop_front();
        }
    }

    pub fn seqs(&self) -> Vec<i64> {
        self.items.iter().map(|s| s.seq).collect()
    }
}

/// What to do with the sample after one attempt.
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// 2xx, `stored` or `ignored`: drop from the buffer.
    Accepted {
        result: String,
        reason: Option<String>,
    },
    /// Not retryable (400, 405, 413, 415, other 4xx and 3xx): log and drop.
    Rejected {
        status: u16,
        code: String,
        field: Option<String>,
    },
    /// Network failure, timeout, 429 or 5xx: retry with backoff.
    Retry {
        why: String,
        after: Option<Duration>,
    },
    /// 401, 403 or 404: keep sampling, retry slowly; the operator fixes it.
    Hold { status: u16, code: String },
}

fn error_body(body: &[u8]) -> (String, Option<String>) {
    let value: serde_json::Value = serde_json::from_slice(body).unwrap_or_default();
    let code = value["error"]["code"].as_str().unwrap_or("unknown");
    let field = value["error"]["field"].as_str();
    let short = |text: &str| text.chars().take(64).collect::<String>();
    (short(code), field.map(short))
}

pub fn classify(status: u16, retry_after: Option<&str>, body: &[u8]) -> Verdict {
    let after = retry_after
        .and_then(|text| text.trim().parse::<u64>().ok())
        .map(Duration::from_secs);
    match status {
        200..=299 => {
            let value: serde_json::Value = serde_json::from_slice(body).unwrap_or_default();
            Verdict::Accepted {
                result: value["result"].as_str().unwrap_or("accepted").into(),
                reason: value["reason"].as_str().map(str::to_owned),
            }
        }
        401 | 403 | 404 => Verdict::Hold {
            status,
            code: error_body(body).0,
        },
        408 | 429 | 500..=599 => Verdict::Retry {
            why: format!("HTTP {status}"),
            after,
        },
        _ => {
            let (code, field) = error_body(body);
            Verdict::Rejected {
                status,
                code,
                field,
            }
        }
    }
}

/// Full-jitter exponential backoff between `min` and a ceiling that doubles
/// per consecutive failure up to `max`. `Retry-After` is a floor, capped at `max`.
pub struct Backoff {
    failures: u32,
    state: u64,
}

impl Backoff {
    pub fn new(seed: u64) -> Self {
        Self {
            failures: 0,
            state: seed | 1,
        }
    }

    fn unit(&mut self) -> f64 {
        // xorshift64*: jitter only, not security.
        self.state ^= self.state >> 12;
        self.state ^= self.state << 25;
        self.state ^= self.state >> 27;
        (self.state.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
    }

    pub fn next(&mut self, timing: &Timing, after: Option<Duration>) -> Duration {
        let ceiling = timing
            .backoff_min
            .saturating_mul(1u32 << self.failures.min(16))
            .min(timing.backoff_max);
        self.failures = self.failures.saturating_add(1);
        let span = ceiling.saturating_sub(timing.backoff_min);
        let delay = timing.backoff_min + span.mul_f64(self.unit());
        match after {
            Some(after) => delay.max(after.min(timing.backoff_max)),
            None => delay,
        }
    }

    pub fn reset(&mut self) {
        self.failures = 0;
    }

    pub fn failures(&self) -> u32 {
        self.failures
    }
}

pub struct Uploader {
    pub client: reqwest::Client,
    pub url: reqwest::Url,
    pub token: Token,
    pub timing: Timing,
}

impl Uploader {
    /// `{api}/v1/devices/factory-console/samples`. Plain http only to loopback,
    /// so the token never crosses a network unencrypted.
    pub fn new(api: &str, token: Token, timing: Timing) -> anyhow::Result<Self> {
        let base = reqwest::Url::parse(api)?;
        let loopback = matches!(base.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
        anyhow::ensure!(
            base.scheme() == "https" || (base.scheme() == "http" && loopback),
            "--api must be https (http only for loopback)"
        );
        anyhow::ensure!(
            base.username().is_empty() && base.password().is_none() && base.query().is_none(),
            "--api must not carry credentials or a query"
        );
        let url = base.join(&format!("v1/devices/{DEVICE_ID}/samples"))?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(format!("{AGENT_NAME}/{AGENT_VERSION}"))
            .build()?;
        Ok(Self {
            client,
            url,
            token,
            timing,
        })
    }

    /// One attempt, bounded by the per-attempt timeout. Errors are reduced to a
    /// kind so no URL, header or body reaches the log.
    pub async fn send(&self, body: Vec<u8>) -> Verdict {
        let request = self
            .client
            .post(self.url.clone())
            .bearer_auth(&self.token.0)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .timeout(self.timing.attempt_timeout);
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                return Verdict::Retry {
                    why: kind(&error),
                    after: None,
                };
            }
        };
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        match response.bytes().await {
            Ok(bytes) => classify(
                status,
                retry_after.as_deref(),
                &bytes[..bytes.len().min(65_536)],
            ),
            Err(error) if (200..300).contains(&status) => {
                debug!(why = kind(&error), "accepted, response body unreadable");
                classify(status, None, b"")
            }
            Err(error) => Verdict::Retry {
                why: kind(&error),
                after: None,
            },
        }
    }
}

fn kind(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect failed"
    } else if error.is_body() || error.is_decode() {
        "response body failed"
    } else {
        "request failed"
    }
    .into()
}

/// Validate with the server's own v1 parser before queueing. A failure here is
/// an agent bug; the sample is dropped like a 400 instead of being sent.
pub fn locally_valid(sample: &DeviceSampleV1) -> Result<(), (String, Option<String>)> {
    let body = serde_json::to_vec(sample).map_err(|e| (e.to_string(), None))?;
    devices_ingest::parse(&body, DEVICE_ID, sample.observed_at_ms)
        .map(|_| ())
        .map_err(|r| (r.code.to_string(), r.field))
}

/// What a run left behind, for the exit log and tests.
#[derive(Debug, Default)]
pub struct Summary {
    pub sampled: u64,
    pub accepted: u64,
    pub rejected: u64,
    pub evicted: u64,
    pub discarded_on_exit: usize,
    /// The collector panicked; the process should exit non-zero so systemd restarts it.
    pub collector_failed: bool,
}

async fn pause(duration: Duration, shutdown: &CancellationToken) -> bool {
    tokio::select! {
        _ = shutdown.cancelled() => false,
        _ = tokio::time::sleep(duration) => true,
    }
}

/// Sample every `timing.fast` and upload oldest first, until `shutdown`.
pub async fn run(
    mut collector: Collector,
    uploader: Uploader,
    buffer_cap: usize,
    shutdown: CancellationToken,
) -> Summary {
    let buffer = Arc::new(Mutex::new(Buffer::new(buffer_cap)));
    let ready = Arc::new(Notify::new());
    let mut seed = 0u64;
    for b in collector.session_id().bytes() {
        seed = seed.rotate_left(5) ^ u64::from(b);
    }
    info!(
        session_id = collector.session_id(),
        version = AGENT_VERSION,
        "agent started"
    );
    let sampling = {
        let (buffer, ready, shutdown) = (buffer.clone(), ready.clone(), shutdown.clone());
        let fast = uploader.timing.fast;
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(fast);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let (mut sampled, mut rejected, mut failed) = (0u64, 0u64, false);
            loop {
                tokio::select! {
                    _ = shutdown.cancelled() => break,
                    _ = ticker.tick() => {}
                }
                let now = now_ms();
                let Ok((mut sample, back)) = tokio::task::spawn_blocking(move || {
                    let sample = collector.sample(now);
                    (sample, collector)
                })
                .await
                else {
                    warn!("collector panicked; stopping");
                    failed = true;
                    shutdown.cancel();
                    break;
                };
                collector = back;
                sampled += 1;
                if sample.seq == 2 {
                    // Second sample: rates exist, so this is the host's real capability set.
                    let rows: Vec<String> = capabilities(&mut sample)
                        .into_iter()
                        .map(|(path, availability, _)| format!("{path}={availability:?}"))
                        .collect();
                    info!(capabilities = rows.join(" "), "discovered sources");
                }
                if let Err((code, field)) = locally_valid(&sample) {
                    rejected += 1;
                    warn!(
                        seq = sample.seq,
                        code, field, "sample failed local contract check; dropped"
                    );
                    continue;
                }
                let evicted = {
                    let mut buffer = buffer.lock().expect("buffer lock");
                    buffer.push(sample).then_some(buffer.evicted)
                };
                if let Some(total) = evicted
                    && (total == 1 || total % 60 == 0)
                {
                    warn!(
                        evicted = total,
                        cap = buffer_cap,
                        "buffer full; dropped the oldest sample"
                    );
                }
                ready.notify_one();
            }
            (sampled, rejected, failed)
        })
    };
    let mut backoff = Backoff::new(seed);
    let mut accepted = 0u64;
    let mut rejected = 0u64;
    let mut auth_logged: Option<Instant> = None;
    loop {
        let next = buffer.lock().expect("buffer lock").next_body(now_ms());
        let Some((seq, body)) = next else {
            tokio::select! {
                _ = shutdown.cancelled() => break,
                _ = ready.notified() => continue,
            }
        };
        let verdict = tokio::select! {
            _ = shutdown.cancelled() => break,
            verdict = uploader.send(body) => verdict,
        };
        match verdict {
            Verdict::Accepted { result, reason } => {
                buffer.lock().expect("buffer lock").done(seq);
                accepted += 1;
                if backoff.failures() > 0 || auth_logged.is_some() {
                    info!(seq, "upload recovered");
                }
                backoff.reset();
                auth_logged = None;
                match reason {
                    Some(reason) => info!(seq, result, reason, "sample accepted"),
                    None => debug!(seq, result, "sample accepted"),
                }
            }
            Verdict::Rejected {
                status,
                code,
                field,
            } => {
                buffer.lock().expect("buffer lock").done(seq);
                rejected += 1;
                backoff.reset();
                warn!(seq, status, code, field, "sample rejected; dropped");
            }
            Verdict::Retry { why, after } => {
                let delay = backoff.next(&uploader.timing, after);
                let pending = buffer.lock().expect("buffer lock").len();
                if backoff.failures() == 1 {
                    warn!(
                        seq,
                        why,
                        retry_in_ms = delay.as_millis() as u64,
                        pending,
                        "upload failed; retrying"
                    );
                } else {
                    debug!(
                        seq,
                        why,
                        retry_in_ms = delay.as_millis() as u64,
                        pending,
                        "upload failed; retrying"
                    );
                }
                if !pause(delay, &shutdown).await {
                    break;
                }
            }
            Verdict::Hold { status, code } => {
                if auth_logged.is_none_or(|at| at.elapsed() >= uploader.timing.auth_log) {
                    warn!(
                        status,
                        code,
                        "credential or endpoint refused; buffering and retrying every 5 minutes"
                    );
                    auth_logged = Some(Instant::now());
                }
                if !pause(uploader.timing.auth_retry, &shutdown).await {
                    break;
                }
            }
        }
    }
    shutdown.cancel();
    // A probe stuck in the kernel must not hold shutdown past systemd's stop timeout.
    let (sampled, local_rejects, collector_failed) =
        match tokio::time::timeout(Duration::from_secs(2), sampling).await {
            Ok(Ok(counts)) => counts,
            _ => (0, 0, false),
        };
    let buffer = buffer.lock().expect("buffer lock");
    Summary {
        sampled,
        accepted,
        rejected: rejected + local_rejects,
        evicted: buffer.evicted,
        discarded_on_exit: buffer.len(),
        collector_failed,
    }
}
