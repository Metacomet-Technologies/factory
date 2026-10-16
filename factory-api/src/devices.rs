//! In-process host probe for factory-gpu. Readings come from /proc and /sys
//! under `devices_root`, plus published backup, reboot, and SMART files.
//! GPU telemetry is the live meter sample. This module does not run nvidia-smi or smartctl.
use crate::types::{GpuCurrent, Service};
use crate::ups::UpsCurrent;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
    sync::mpsc,
    time::Duration,
};
use utoipa::ToSchema;

pub const DEVICE_ID: &str = "factory-gpu";
pub const FAST_INTERVAL_MS: i64 = 15_000;
pub const SLOW_INTERVAL_MS: i64 = 300_000;
pub const DEFAULT_REBOOT_STATUS: &str = "/var/lib/factory-reboot/status.json";
pub const READ_CAP: usize = 1_048_576;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Available,
    Unsupported,
    PermissionDenied,
    Stale,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum HealthStatus {
    Critical,
    Warning,
    Healthy,
    Unknown,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct Metric {
    pub value: Option<f64>,
    pub unit: String,
    pub observed_at_ms: i64,
    pub availability: Availability,
    pub detail: Option<String>,
}

pub fn metric(
    unit: &str,
    observed_at_ms: i64,
    availability: Availability,
    value: Option<f64>,
    detail: Option<String>,
) -> Metric {
    let (availability, value) = match availability {
        Availability::Available => match value.filter(|value| value.is_finite()) {
            Some(value) => (Availability::Available, Some(value)),
            None => (Availability::Error, None),
        },
        other => (other, None),
    };
    Metric {
        value,
        unit: unit.into(),
        observed_at_ms,
        availability,
        detail,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct HealthReason {
    pub status: HealthStatus,
    pub metric: String,
    pub threshold: String,
    pub value: Option<f64>,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct HealthReport {
    pub status: HealthStatus,
    pub reasons: Vec<HealthReason>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct HostIdentity {
    pub hostname: Option<String>,
    pub boot_id: Option<String>,
    pub uptime: Metric,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct Cpu {
    pub utilization: Metric,
    pub iowait: Metric,
    pub load1: Metric,
    pub load5: Metric,
    pub load15: Metric,
    pub temperature: Metric,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct Ram {
    pub total: Metric,
    pub available: Metric,
    pub used: Metric,
    pub swap_total: Metric,
    pub swap_free: Metric,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct GpuSlot {
    pub index: i64,
    pub memory_used: Metric,
    pub memory_total: Metric,
    pub utilization: Metric,
    pub temperature: Metric,
    pub power: Metric,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct Filesystem {
    pub id: String,
    pub source: String,
    pub mountpoint: String,
    pub fstype: String,
    pub size: Metric,
    pub used: Metric,
    pub used_percent: Metric,
    pub inodes_used_percent: Metric,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct SmartStatus {
    pub availability: Availability,
    pub passed: Option<bool>,
    pub observed_at_ms: i64,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct Drive {
    pub id: String,
    pub kernel: String,
    pub model: Option<String>,
    pub size: Metric,
    pub smart: SmartStatus,
    pub available_spare: Metric,
    pub spare_threshold_percent: Option<f64>,
    pub media_errors: Metric,
    pub media_critical: bool,
    pub temperature: Metric,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct DiskIo {
    pub read: Metric,
    pub write: Metric,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct Network {
    pub rx: Metric,
    pub tx: Metric,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct NamedMetric {
    pub name: String,
    pub metric: Metric,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct Cooling {
    pub temperatures: Vec<NamedMetric>,
    pub fans: Vec<NamedMetric>,
    pub temperatures_availability: Availability,
    pub fans_availability: Availability,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct BackupView {
    pub availability: Availability,
    pub last_success_ms: Option<i64>,
    pub last_attempt_ms: Option<i64>,
    pub error: Option<String>,
    pub observed_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct RebootView {
    pub availability: Availability,
    pub reboot_required: Option<bool>,
    pub pending_since_ms: Option<i64>,
    pub days_pending: Option<i64>,
    pub consecutive_skips: Option<i64>,
    pub alert_due: Option<bool>,
    pub last_check_ms: Option<i64>,
    pub last_decision: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct ClockView {
    pub synchronized: Option<bool>,
    pub availability: Availability,
    pub observed_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct UpsSummary {
    pub href: String,
    pub availability: Availability,
    pub status: Option<String>,
    pub charge_percent: Option<f64>,
    pub observed_at_ms: i64,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct Maintenance {
    pub services: Vec<Service>,
    pub backup: BackupView,
    pub clock: ClockView,
    pub reboot: RebootView,
    pub ups: UpsSummary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct CollectorHealth {
    pub fast_interval_ms: i64,
    pub slow_interval_ms: i64,
    pub last_fast_ms: Option<i64>,
    pub last_slow_ms: Option<i64>,
    pub fast_ok: bool,
    pub filesystems: Availability,
    pub drives: Availability,
    pub smart: Availability,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct HostSnapshot {
    pub device_id: String,
    pub observed_at_ms: i64,
    pub identity: HostIdentity,
    pub cpu: Cpu,
    pub memory: Ram,
    pub gpus: Vec<GpuSlot>,
    pub filesystems: Vec<Filesystem>,
    pub drives: Vec<Drive>,
    pub disk_io: DiskIo,
    pub network: Network,
    pub cooling: Cooling,
    pub maintenance: Maintenance,
    pub collector: CollectorHealth,
    pub health: HealthReport,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct DeviceView {
    pub generated_at_ms: i64,
    pub warnings: Vec<String>,
    pub device: HostSnapshot,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct DeviceSummary {
    pub device_id: String,
    pub health: HealthStatus,
    pub href: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct DeviceList {
    pub generated_at_ms: i64,
    pub devices: Vec<DeviceSummary>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct FsPressure {
    pub id: String,
    pub space_percent: Option<f64>,
    pub inode_percent: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SmartPressure {
    pub id: String,
    /// None keeps an open alert. Some(true) is unhealthy. Some(false) may clear.
    pub unhealthy: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DeviceAlertInput {
    pub fast_success_ms: Option<i64>,
    /// None: unreadable, hold. Some(None): sensor unsupported. Some(Some): celsius.
    pub cpu_temp_c: Option<Option<f64>>,
    pub filesystems: Option<Vec<FsPressure>>,
    pub smart: Option<Vec<SmartPressure>>,
}

fn rank(status: HealthStatus) -> u8 {
    match status {
        HealthStatus::Critical => 4,
        HealthStatus::Warning => 3,
        HealthStatus::Stale => 2,
        HealthStatus::Unknown => 1,
        HealthStatus::Healthy => 0,
    }
}

fn reason(
    status: HealthStatus,
    metric_name: &str,
    threshold: &str,
    value: Option<f64>,
    detail: impl Into<String>,
) -> HealthReason {
    HealthReason {
        status,
        metric: metric_name.into(),
        threshold: threshold.into(),
        value,
        detail: detail.into(),
    }
}

fn worse(level: f64, warn: f64, crit: f64) -> Option<HealthStatus> {
    if level >= crit {
        Some(HealthStatus::Critical)
    } else if level >= warn {
        Some(HealthStatus::Warning)
    } else {
        None
    }
}

/// Pure health report. Missing essential readings are not healthy.
/// Unsupported fans and unsupported SMART do not fail the host.
pub fn assess(host: &HostSnapshot, now: i64) -> HealthReport {
    let mut reasons = Vec::new();
    let aged = host
        .collector
        .last_fast_ms
        .is_none_or(|at| now.saturating_sub(at) > FAST_INTERVAL_MS * 2);
    if !host.collector.fast_ok || aged && host.collector.last_fast_ms.is_some() {
        let age = host
            .collector
            .last_fast_ms
            .map(|at| now.saturating_sub(at) as f64);
        reasons.push(reason(
            HealthStatus::Stale,
            "collector.fast",
            "30 s",
            age,
            if host.collector.fast_ok {
                "latest fast sample is older than twice its 15 s interval"
            } else {
                "device collector failed"
            },
        ));
    }
    if host.cpu.utilization.availability != Availability::Available {
        reasons.push(reason(
            HealthStatus::Unknown,
            "cpu.utilization",
            "present",
            None,
            host.cpu
                .utilization
                .detail
                .clone()
                .unwrap_or_else(|| "CPU utilization is missing".into()),
        ));
    }
    if host.memory.total.availability != Availability::Available {
        reasons.push(reason(
            HealthStatus::Unknown,
            "memory.total",
            "present",
            None,
            "memory total is missing",
        ));
    }
    if !host
        .filesystems
        .iter()
        .any(|fs| fs.size.availability == Availability::Available)
    {
        reasons.push(reason(
            HealthStatus::Unknown,
            "filesystem.size",
            "present",
            None,
            "filesystem capacity is missing",
        ));
    }
    if host.identity.uptime.availability != Availability::Available {
        reasons.push(reason(
            HealthStatus::Unknown,
            "host.uptime",
            "present",
            None,
            "host uptime is missing",
        ));
    }
    if host.maintenance.reboot.availability == Availability::PermissionDenied {
        reasons.push(reason(
            HealthStatus::Unknown,
            "maintenance.reboot",
            "readable",
            None,
            "reboot status is not readable",
        ));
    }
    if let Some(value) = host.cpu.temperature.value
        && host.cpu.temperature.availability == Availability::Available
        && let Some(status) = worse(value, 80.0, 95.0)
    {
        reasons.push(reason(
            status,
            "cpu.temperature",
            if status == HealthStatus::Critical {
                "95 C"
            } else {
                "80 C"
            },
            Some(value),
            format!("CPU temperature {value:.1} C"),
        ));
    }
    for fs in &host.filesystems {
        if let Some(value) = fs.used_percent.value
            && fs.used_percent.availability == Availability::Available
            && let Some(status) = worse(value, 85.0, 95.0)
        {
            reasons.push(reason(
                status,
                &format!("filesystem.{}", fs.id),
                if status == HealthStatus::Critical {
                    "95%"
                } else {
                    "85%"
                },
                Some(value),
                format!("{} space {:.1}%", fs.mountpoint, value),
            ));
        }
        if let Some(value) = fs.inodes_used_percent.value
            && fs.inodes_used_percent.availability == Availability::Available
            && let Some(status) = worse(value, 85.0, 95.0)
        {
            reasons.push(reason(
                status,
                &format!("filesystem.{}.inodes", fs.id),
                if status == HealthStatus::Critical {
                    "95%"
                } else {
                    "85%"
                },
                Some(value),
                format!("{} inodes {:.1}%", fs.mountpoint, value),
            ));
        }
    }
    for drive in &host.drives {
        if drive.smart.passed == Some(false) {
            reasons.push(reason(
                HealthStatus::Critical,
                &format!("drive.{}.smart", drive.id),
                "passed",
                None,
                format!("{} SMART failed", drive.kernel),
            ));
        }
        if let (Some(spare), Some(threshold)) =
            (drive.available_spare.value, drive.spare_threshold_percent)
            && drive.available_spare.availability == Availability::Available
            && spare <= threshold
        {
            reasons.push(reason(
                HealthStatus::Critical,
                &format!("drive.{}.spare", drive.id),
                &format!("above {threshold}%"),
                Some(spare),
                format!("{} spare {:.1}%", drive.kernel, spare),
            ));
        }
        if drive.media_critical {
            reasons.push(reason(
                HealthStatus::Critical,
                &format!("drive.{}.media", drive.id),
                "not critical",
                drive.media_errors.value,
                format!("{} media errors are critical", drive.kernel),
            ));
        }
    }
    reasons.sort_by(|a, b| {
        rank(b.status)
            .cmp(&rank(a.status))
            .then(a.metric.cmp(&b.metric))
    });
    let status = reasons
        .iter()
        .map(|reason| reason.status)
        .max_by_key(|status| rank(*status))
        .unwrap_or(HealthStatus::Healthy);
    HealthReport { status, reasons }
}

fn blank_metric(unit: &str, at: i64, availability: Availability, detail: &str) -> Metric {
    metric(unit, at, availability, None, Some(detail.into()))
}

pub fn unavailable(now: i64) -> DeviceView {
    let waiting = "waiting for the first sample";
    let host = HostSnapshot {
        device_id: DEVICE_ID.into(),
        observed_at_ms: now,
        identity: HostIdentity {
            hostname: None,
            boot_id: None,
            uptime: blank_metric("s", now, Availability::Unsupported, waiting),
        },
        cpu: Cpu {
            utilization: blank_metric("%", now, Availability::Unsupported, waiting),
            iowait: blank_metric("%", now, Availability::Unsupported, waiting),
            load1: blank_metric("load", now, Availability::Unsupported, waiting),
            load5: blank_metric("load", now, Availability::Unsupported, waiting),
            load15: blank_metric("load", now, Availability::Unsupported, waiting),
            temperature: blank_metric("C", now, Availability::Unsupported, waiting),
        },
        memory: Ram {
            total: blank_metric("bytes", now, Availability::Unsupported, waiting),
            available: blank_metric("bytes", now, Availability::Unsupported, waiting),
            used: blank_metric("bytes", now, Availability::Unsupported, waiting),
            swap_total: blank_metric("bytes", now, Availability::Unsupported, waiting),
            swap_free: blank_metric("bytes", now, Availability::Unsupported, waiting),
        },
        gpus: vec![],
        filesystems: vec![],
        drives: vec![],
        disk_io: DiskIo {
            read: blank_metric("B/s", now, Availability::Unsupported, waiting),
            write: blank_metric("B/s", now, Availability::Unsupported, waiting),
        },
        network: Network {
            rx: blank_metric("B/s", now, Availability::Unsupported, waiting),
            tx: blank_metric("B/s", now, Availability::Unsupported, waiting),
        },
        cooling: Cooling {
            temperatures: vec![],
            fans: vec![],
            temperatures_availability: Availability::Unsupported,
            fans_availability: Availability::Unsupported,
        },
        maintenance: Maintenance {
            services: vec![],
            backup: BackupView {
                availability: Availability::Unsupported,
                last_success_ms: None,
                last_attempt_ms: None,
                error: None,
                observed_at_ms: now,
            },
            clock: ClockView {
                synchronized: None,
                availability: Availability::Unsupported,
                observed_at_ms: now,
            },
            reboot: RebootView {
                availability: Availability::Unsupported,
                reboot_required: None,
                pending_since_ms: None,
                days_pending: None,
                consecutive_skips: None,
                alert_due: None,
                last_check_ms: None,
                last_decision: None,
                detail: Some(waiting.into()),
            },
            ups: UpsSummary {
                href: "/ups".into(),
                availability: Availability::Unsupported,
                status: None,
                charge_percent: None,
                observed_at_ms: now,
                detail: Some(waiting.into()),
            },
        },
        collector: CollectorHealth {
            fast_interval_ms: FAST_INTERVAL_MS,
            slow_interval_ms: SLOW_INTERVAL_MS,
            last_fast_ms: None,
            last_slow_ms: None,
            fast_ok: true,
            filesystems: Availability::Unsupported,
            drives: Availability::Unsupported,
            smart: Availability::Unsupported,
            detail: Some(waiting.into()),
        },
        health: HealthReport {
            status: HealthStatus::Unknown,
            reasons: vec![],
        },
    };
    let mut view = DeviceView {
        generated_at_ms: now,
        warnings: vec![waiting.into()],
        device: host,
    };
    view.device.health = assess(&view.device, now);
    view
}

fn mark_stale(metric: &mut Metric, detail: String) {
    if metric.availability == Availability::Available {
        metric.availability = Availability::Stale;
        metric.value = None;
        metric.detail = Some(detail);
    }
}

/// A served copy. Fast numbers older than two intervals are not presented as current.
pub fn freshen(view: &DeviceView, now: i64) -> DeviceView {
    let mut copy = view.clone();
    copy.generated_at_ms = now;
    let age = now.saturating_sub(copy.device.observed_at_ms);
    if age > FAST_INTERVAL_MS * 2 {
        let detail = format!("last sample at {}", copy.device.observed_at_ms);
        mark_stale(&mut copy.device.cpu.utilization, detail.clone());
        mark_stale(&mut copy.device.cpu.iowait, detail.clone());
        mark_stale(&mut copy.device.cpu.load1, detail.clone());
        mark_stale(&mut copy.device.cpu.load5, detail.clone());
        mark_stale(&mut copy.device.cpu.load15, detail.clone());
        mark_stale(&mut copy.device.memory.total, detail.clone());
        mark_stale(&mut copy.device.memory.available, detail.clone());
        mark_stale(&mut copy.device.memory.used, detail.clone());
        mark_stale(&mut copy.device.disk_io.read, detail.clone());
        mark_stale(&mut copy.device.disk_io.write, detail.clone());
        mark_stale(&mut copy.device.network.rx, detail.clone());
        mark_stale(&mut copy.device.network.tx, detail);
    }
    if copy.collector_slow_age(now) > SLOW_INTERVAL_MS * 2 {
        let detail = "slow inventory is older than twice its interval".to_string();
        mark_stale(&mut copy.device.cpu.temperature, detail.clone());
        for fs in &mut copy.device.filesystems {
            mark_stale(&mut fs.size, detail.clone());
            mark_stale(&mut fs.used, detail.clone());
            mark_stale(&mut fs.used_percent, detail.clone());
            mark_stale(&mut fs.inodes_used_percent, detail.clone());
        }
    }
    copy.device.health = assess(&copy.device, now);
    copy
}

impl DeviceView {
    fn collector_slow_age(&self, now: i64) -> i64 {
        self.device
            .collector
            .last_slow_ms
            .map(|at| now.saturating_sub(at))
            .unwrap_or(i64::MAX)
    }

    pub fn alert_input(&self, now: i64) -> DeviceAlertInput {
        let fast_fresh = self.device.collector.fast_ok
            && self
                .device
                .collector
                .last_fast_ms
                .is_some_and(|at| now.saturating_sub(at) <= 120_000);
        let cpu_temp_c = if !fast_fresh
            && self.device.cpu.temperature.availability != Availability::Unsupported
        {
            None
        } else {
            match self.device.cpu.temperature.availability {
                Availability::Available => Some(self.device.cpu.temperature.value),
                Availability::Unsupported => Some(None),
                _ => None,
            }
        };
        let filesystems = if !fast_fresh
            || matches!(
                self.device.collector.filesystems,
                Availability::Error | Availability::PermissionDenied | Availability::Stale
            ) {
            None
        } else {
            Some(
                self.device
                    .filesystems
                    .iter()
                    .map(|fs| FsPressure {
                        id: fs.id.clone(),
                        space_percent: (fs.used_percent.availability == Availability::Available)
                            .then_some(fs.used_percent.value)
                            .flatten(),
                        inode_percent: (fs.inodes_used_percent.availability
                            == Availability::Available)
                            .then_some(fs.inodes_used_percent.value)
                            .flatten(),
                    })
                    .collect(),
            )
        };
        let smart = if matches!(
            self.device.collector.smart,
            Availability::Error | Availability::PermissionDenied | Availability::Stale
        ) {
            None
        } else {
            Some(
                self.device
                    .drives
                    .iter()
                    .map(|drive| SmartPressure {
                        id: drive.id.clone(),
                        unhealthy: smart_unhealthy(drive),
                    })
                    .collect(),
            )
        };
        DeviceAlertInput {
            fast_success_ms: self
                .device
                .collector
                .fast_ok
                .then_some(self.device.collector.last_fast_ms)
                .flatten(),
            cpu_temp_c,
            filesystems,
            smart,
        }
    }

    pub fn summary(&self) -> DeviceSummary {
        DeviceSummary {
            device_id: self.device.device_id.clone(),
            health: self.device.health.status,
            href: format!("/devices/{}", self.device.device_id),
        }
    }
}

fn smart_unhealthy(drive: &Drive) -> Option<bool> {
    if drive.smart.availability == Availability::Unsupported {
        return None;
    }
    if drive.smart.availability != Availability::Available {
        return None;
    }
    let spare = match (drive.available_spare.value, drive.spare_threshold_percent) {
        (Some(value), Some(threshold))
            if drive.available_spare.availability == Availability::Available =>
        {
            value <= threshold
        }
        _ => false,
    };
    Some(drive.smart.passed == Some(false) || spare || drive.media_critical)
}

#[derive(Debug)]
enum ProbeError {
    Missing,
    Denied,
    Timeout,
    TooLarge,
    Malformed,
    Io(String),
}

fn map_io(error: io::Error) -> ProbeError {
    match error.kind() {
        io::ErrorKind::NotFound => ProbeError::Missing,
        io::ErrorKind::PermissionDenied => ProbeError::Denied,
        _ => ProbeError::Io(error.to_string()),
    }
}

fn read_limited(path: &Path, timeout: Duration) -> Result<Vec<u8>, ProbeError> {
    let path = path.to_path_buf();
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = tx.send(fs::read(&path));
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(bytes)) if bytes.len() > READ_CAP => Err(ProbeError::TooLarge),
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(error)) => Err(map_io(error)),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(ProbeError::Timeout),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(ProbeError::Io("read ended".into())),
    }
}

fn read_text(path: &Path, timeout: Duration) -> Result<String, ProbeError> {
    let bytes = read_limited(path, timeout)?;
    String::from_utf8(bytes).map_err(|_| ProbeError::Malformed)
}

fn availability_of(error: &ProbeError) -> Availability {
    match error {
        ProbeError::Denied => Availability::PermissionDenied,
        ProbeError::Missing
        | ProbeError::Timeout
        | ProbeError::TooLarge
        | ProbeError::Malformed
        | ProbeError::Io(_) => Availability::Error,
    }
}

fn detail_of(error: &ProbeError) -> String {
    match error {
        ProbeError::Missing => "missing".into(),
        ProbeError::Denied => "permission denied".into(),
        ProbeError::Timeout => "timed out".into(),
        ProbeError::TooLarge => "output exceeded 1 MiB".into(),
        ProbeError::Malformed => "malformed".into(),
        ProbeError::Io(text) => text.clone(),
    }
}

fn failed(unit: &str, at: i64, error: &ProbeError) -> Metric {
    metric(
        unit,
        at,
        availability_of(error),
        None,
        Some(detail_of(error)),
    )
}

#[derive(Clone, Copy)]
struct CpuCounters {
    user: u64,
    nice: u64,
    system: u64,
    idle: u64,
    iowait: u64,
    irq: u64,
    softirq: u64,
    steal: u64,
}

fn parse_cpu(text: &str) -> Option<CpuCounters> {
    let line = text.lines().find(|line| line.starts_with("cpu "))?;
    let nums: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .map(|field| field.parse().ok())
        .collect::<Option<_>>()?;
    if nums.len() < 8 {
        return None;
    }
    Some(CpuCounters {
        user: nums[0],
        nice: nums[1],
        system: nums[2],
        idle: nums[3],
        iowait: nums[4],
        irq: nums[5],
        softirq: nums[6],
        steal: nums[7],
    })
}

fn counter_decreased(prev: &CpuCounters, next: &CpuCounters) -> bool {
    next.user < prev.user
        || next.nice < prev.nice
        || next.system < prev.system
        || next.idle < prev.idle
        || next.iowait < prev.iowait
        || next.irq < prev.irq
        || next.softirq < prev.softirq
        || next.steal < prev.steal
}

fn percent_delta(prev: u64, next: u64, total: u64) -> Option<f64> {
    (total > 0).then(|| (next.saturating_sub(prev)) as f64 / total as f64 * 100.0)
}

#[derive(Default)]
struct Window {
    boot_id: Option<String>,
    cpu: Option<CpuCounters>,
    at_ms: Option<i64>,
    disks: BTreeMap<String, (u64, u64)>,
    nets: BTreeMap<String, (u64, u64)>,
}

struct Slow {
    at_ms: i64,
    filesystems: Vec<Filesystem>,
    filesystems_availability: Availability,
    drives: Vec<Drive>,
    drives_availability: Availability,
    smart: Availability,
    cooling: Cooling,
    cpu_temp: Metric,
}

#[derive(Default)]
pub struct Sampler {
    window: Window,
    slow: Option<Slow>,
    last_fast_ms: Option<i64>,
}

pub struct Inputs {
    pub now_ms: i64,
    pub gpu: Option<GpuCurrent>,
    pub ups: Option<UpsCurrent>,
    pub services: Vec<Service>,
    pub backup_path: PathBuf,
    pub reboot_path: PathBuf,
    pub clock_synchronized: bool,
}

const EXCLUDED_FS: &[&str] = &[
    "proc",
    "sysfs",
    "devtmpfs",
    "devpts",
    "cgroup",
    "cgroup2",
    "overlay",
    "squashfs",
    "tmpfs",
    "autofs",
    "bpf",
    "tracefs",
    "debugfs",
    "securityfs",
    "pstore",
    "configfs",
    "fusectl",
    "mqueue",
    "hugetlbfs",
    "ramfs",
    "nsfs",
    "rpc_pipefs",
    "binfmt_misc",
    "efivarfs",
    "fuse.portal",
    "fuse.gvfsd-fuse",
    "none",
    "selinuxfs",
    "functionfs",
];

fn included_fs(fstype: &str) -> bool {
    !EXCLUDED_FS.contains(&fstype) && !fstype.starts_with("cgroup")
}

fn unescape(value: &str) -> String {
    let mut out = String::new();
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\\'
            && index + 3 < bytes.len()
            && let Ok(code) = u8::from_str_radix(&value[index + 1..index + 4], 8)
        {
            out.push(code as char);
            index += 4;
            continue;
        }
        out.push(bytes[index] as char);
        index += 1;
    }
    out
}

struct Mount {
    source: String,
    mountpoint: String,
    fstype: String,
}

fn parse_mountinfo(text: &str) -> Vec<Mount> {
    text.lines()
        .filter_map(|line| {
            let (pre, post) = line.split_once(" - ")?;
            let pre: Vec<_> = pre.split_whitespace().collect();
            let post: Vec<_> = post.split_whitespace().collect();
            if pre.len() < 5 || post.len() < 2 {
                return None;
            }
            Some(Mount {
                mountpoint: unescape(pre[4]),
                fstype: post[0].to_string(),
                source: unescape(post[1]),
            })
        })
        .collect()
}

fn parse_mounts(text: &str) -> Vec<Mount> {
    text.lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() < 3 {
                return None;
            }
            Some(Mount {
                source: unescape(fields[0]),
                mountpoint: unescape(fields[1]),
                fstype: fields[2].to_string(),
            })
        })
        .collect()
}

fn parse_meminfo(text: &str) -> BTreeMap<String, u64> {
    text.lines()
        .filter_map(|line| {
            let (key, rest) = line.split_once(':')?;
            let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
            Some((key.to_string(), kb.saturating_mul(1024)))
        })
        .collect()
}

fn virtual_disk(name: &str) -> bool {
    name.starts_with("loop")
        || name.starts_with("ram")
        || name.starts_with("fd")
        || name.starts_with("dm-")
        || name.starts_with("md")
        || name.starts_with("zram")
        || name.starts_with("nbd")
        || name.starts_with("sr")
        || name.starts_with("zd")
}

fn parse_diskstats(text: &str) -> BTreeMap<String, (u64, u64)> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() < 11 {
            continue;
        }
        let (Ok(read), Ok(write)) = (fields[5].parse::<u64>(), fields[9].parse::<u64>()) else {
            continue;
        };
        out.insert(fields[2].to_string(), (read, write));
    }
    out
}

fn parse_netdev(text: &str) -> BTreeMap<String, (u64, u64)> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() || name == "lo" || name.starts_with("Inter") || name.starts_with("face")
        {
            continue;
        }
        let nums: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|field| field.parse().ok())
            .collect();
        if nums.len() >= 9 {
            out.insert(name.to_string(), (nums[0], nums[8]));
        }
    }
    out
}

fn child_path(root: &Path, rel: &str) -> PathBuf {
    root.join(rel)
}

fn pair_rate(
    prev: &BTreeMap<String, (u64, u64)>,
    next: &BTreeMap<String, (u64, u64)>,
    elapsed_ms: i64,
    scale: f64,
) -> Option<(f64, f64)> {
    if elapsed_ms <= 0
        || elapsed_ms > FAST_INTERVAL_MS * 2
        || prev.is_empty()
        || prev.len() != next.len()
    {
        return None;
    }
    let mut read = 0u64;
    let mut write = 0u64;
    for (name, (left, right)) in prev {
        let (next_left, next_right) = next.get(name)?;
        if next_left < left || next_right < right {
            return None;
        }
        read = read.saturating_add(next_left - left);
        write = write.saturating_add(next_right - right);
    }
    let seconds = elapsed_ms as f64 / 1000.0;
    Some((
        read as f64 * scale / seconds,
        write as f64 * scale / seconds,
    ))
}

fn bytes_metric(at: i64, value: Option<u64>) -> Metric {
    match value {
        Some(value) => metric(
            "bytes",
            at,
            Availability::Available,
            Some(value as f64),
            None,
        ),
        None => blank_metric("bytes", at, Availability::Error, "malformed"),
    }
}

fn percent_of(used: Option<f64>, total: Option<f64>, at: i64) -> Metric {
    match (used, total) {
        (Some(used), Some(total)) if total > 0.0 => metric(
            "%",
            at,
            Availability::Available,
            Some(used / total * 100.0),
            None,
        ),
        _ => blank_metric("%", at, Availability::Error, "capacity missing"),
    }
}

#[derive(Clone)]
struct Capacities {
    total: u64,
    used: u64,
    inodes: u64,
    inodes_used: u64,
}

fn parse_mountstat(text: &str) -> BTreeMap<String, Capacities> {
    text.lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split('\t').collect();
            if fields.len() != 5 {
                return None;
            }
            Some((
                fields[0].to_string(),
                Capacities {
                    total: fields[1].parse().ok()?,
                    used: fields[2].parse().ok()?,
                    inodes: fields[3].parse().ok()?,
                    inodes_used: fields[4].parse().ok()?,
                },
            ))
        })
        .collect()
}

fn stat_mount(path: &Path) -> Option<Capacities> {
    let text = path.to_str()?;
    let c_path = std::ffi::CString::new(text).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    let total = stat.f_blocks.saturating_mul(stat.f_frsize as u64);
    let free = stat.f_bfree.saturating_mul(stat.f_frsize as u64);
    let inodes = stat.f_files;
    let inodes_free = stat.f_ffree;
    Some(Capacities {
        total,
        used: total.saturating_sub(free),
        inodes,
        inodes_used: inodes.saturating_sub(inodes_free),
    })
}

fn filesystem_from(mount: &Mount, cap: Option<&Capacities>, at: i64) -> Filesystem {
    let id = format!("{}\t{}", mount.source, mount.mountpoint);
    let (size, used, inodes) = if let Some(cap) = cap {
        (
            metric(
                "bytes",
                at,
                Availability::Available,
                Some(cap.total as f64),
                None,
            ),
            metric(
                "bytes",
                at,
                Availability::Available,
                Some(cap.used as f64),
                None,
            ),
            if cap.inodes == 0 {
                blank_metric(
                    "%",
                    at,
                    Availability::Unsupported,
                    "filesystem has no inode count",
                )
            } else {
                metric(
                    "%",
                    at,
                    Availability::Available,
                    Some(cap.inodes_used as f64 / cap.inodes as f64 * 100.0),
                    None,
                )
            },
        )
    } else {
        (
            blank_metric("bytes", at, Availability::Error, "capacity missing"),
            blank_metric("bytes", at, Availability::Error, "capacity missing"),
            blank_metric("%", at, Availability::Error, "capacity missing"),
        )
    };
    let used_percent = percent_of(used.value, size.value, at);
    Filesystem {
        id,
        source: mount.source.clone(),
        mountpoint: mount.mountpoint.clone(),
        fstype: mount.fstype.clone(),
        size,
        used,
        used_percent,
        inodes_used_percent: inodes,
    }
}

fn read_dir_names(path: &Path) -> Result<Vec<String>, ProbeError> {
    let mut names = Vec::new();
    for entry in fs::read_dir(path).map_err(map_io)? {
        let entry = entry.map_err(map_io)?;
        if let Some(name) = entry.file_name().to_str() {
            names.push(name.to_string());
        }
        if names.len() == 256 {
            break;
        }
    }
    names.sort();
    Ok(names)
}

fn sys_string(path: &Path, timeout: Duration) -> Option<String> {
    read_text(path, timeout)
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn physical_disks(root: &Path) -> Result<Vec<String>, ProbeError> {
    let names = read_dir_names(&child_path(root, "sys/block"))?;
    Ok(names
        .into_iter()
        .filter(|name| {
            !virtual_disk(name)
                && !child_path(root, &format!("sys/block/{name}/partition")).exists()
        })
        .collect())
}

fn load_drives(root: &Path, at: i64, timeout: Duration) -> (Vec<Drive>, Availability) {
    let names = match physical_disks(root) {
        Ok(names) => names,
        Err(error) => return (vec![], availability_of(&error)),
    };
    if names.is_empty() {
        return (vec![], Availability::Unsupported);
    }
    let drives = names
        .into_iter()
        .map(|kernel| {
            let base = child_path(root, &format!("sys/block/{kernel}"));
            let model = sys_string(&base.join("device/model"), timeout);
            let wwn = sys_string(&base.join("device/wwid"), timeout)
                .or_else(|| sys_string(&base.join("wwid"), timeout))
                .or_else(|| sys_string(&base.join("device/wwn"), timeout));
            let serial = sys_string(&base.join("device/serial"), timeout);
            let id = wwn
                .clone()
                .or_else(|| serial.clone())
                .unwrap_or_else(|| kernel.clone());
            let sectors =
                sys_string(&base.join("size"), timeout).and_then(|text| text.parse::<u64>().ok());
            let size = match sectors {
                Some(sectors) => metric(
                    "bytes",
                    at,
                    Availability::Available,
                    Some(sectors.saturating_mul(512) as f64),
                    None,
                ),
                None => blank_metric("bytes", at, Availability::Error, "size missing"),
            };
            Drive {
                id,
                kernel,
                model,
                size,
                smart: SmartStatus {
                    availability: Availability::PermissionDenied,
                    passed: None,
                    observed_at_ms: at,
                    detail: Some("SMART snapshot missing".into()),
                },
                available_spare: blank_metric(
                    "%",
                    at,
                    Availability::PermissionDenied,
                    "SMART snapshot missing",
                ),
                spare_threshold_percent: None,
                media_errors: blank_metric(
                    "count",
                    at,
                    Availability::PermissionDenied,
                    "SMART snapshot missing",
                ),
                media_critical: false,
                temperature: blank_metric(
                    "C",
                    at,
                    Availability::PermissionDenied,
                    "SMART snapshot missing",
                ),
            }
        })
        .collect();
    (drives, Availability::Available)
}

#[derive(Deserialize)]
struct SmartFile {
    #[serde(default)]
    observed_at_ms: Option<i64>,
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    drives: Vec<SmartEntry>,
}

#[derive(Deserialize)]
struct SmartEntry {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    kernel: Option<String>,
    #[serde(default)]
    passed: Option<bool>,
    #[serde(default)]
    unsupported: Option<bool>,
    #[serde(default)]
    available_spare_percent: Option<f64>,
    #[serde(default)]
    spare_threshold_percent: Option<f64>,
    #[serde(default)]
    media_errors: Option<f64>,
    #[serde(default)]
    media_critical: Option<bool>,
    #[serde(default)]
    temperature_c: Option<f64>,
}

fn apply_smart(drives: &mut [Drive], root: &Path, at: i64, timeout: Duration) -> Availability {
    let path = child_path(root, "var/lib/factory-devices/smart.json");
    let text = match read_text(&path, timeout) {
        Ok(text) => text,
        Err(ProbeError::Missing | ProbeError::Denied) => return Availability::PermissionDenied,
        Err(error) => return availability_of(&error),
    };
    let file: SmartFile = match serde_json::from_str(&text) {
        Ok(file) => file,
        Err(_) => {
            for drive in drives.iter_mut() {
                drive.smart.availability = Availability::Error;
                drive.smart.detail = Some("malformed".into());
                drive.available_spare = blank_metric("%", at, Availability::Error, "malformed");
                drive.media_errors = blank_metric("count", at, Availability::Error, "malformed");
                drive.temperature = blank_metric("C", at, Availability::Error, "malformed");
            }
            return Availability::Error;
        }
    };
    let observed = file.observed_at_ms.unwrap_or(at);
    let tool_absent = file.tool.as_deref() == Some("absent");
    for drive in drives.iter_mut() {
        let entry = file.drives.iter().find(|entry| {
            entry.id.as_deref() == Some(drive.id.as_str())
                || entry.kernel.as_deref() == Some(drive.kernel.as_str())
        });
        match entry {
            Some(entry) if tool_absent || entry.unsupported == Some(true) => {
                unsupported_smart(drive, observed)
            }
            Some(entry) => {
                drive.smart = SmartStatus {
                    availability: Availability::Available,
                    passed: entry.passed,
                    observed_at_ms: observed,
                    detail: Some(
                        if entry.passed == Some(false) {
                            "failed"
                        } else {
                            "passed"
                        }
                        .into(),
                    ),
                };
                drive.available_spare = match entry
                    .available_spare_percent
                    .filter(|value| value.is_finite())
                {
                    Some(value) => {
                        metric("%", observed, Availability::Available, Some(value), None)
                    }
                    None => {
                        blank_metric("%", observed, Availability::Unsupported, "no spare counter")
                    }
                };
                drive.spare_threshold_percent = entry
                    .spare_threshold_percent
                    .filter(|value| value.is_finite());
                drive.media_errors = match entry.media_errors.filter(|value| value.is_finite()) {
                    Some(value) => metric(
                        "count",
                        observed,
                        Availability::Available,
                        Some(value),
                        None,
                    ),
                    None => blank_metric(
                        "count",
                        observed,
                        Availability::Unsupported,
                        "no media counter",
                    ),
                };
                drive.media_critical = entry.media_critical.unwrap_or(false);
                drive.temperature = match entry.temperature_c.filter(|value| value.is_finite()) {
                    Some(value) => {
                        metric("C", observed, Availability::Available, Some(value), None)
                    }
                    None => {
                        blank_metric("C", observed, Availability::Unsupported, "no temperature")
                    }
                };
            }
            None if tool_absent => unsupported_smart(drive, observed),
            None => {
                drive.smart.detail = Some("drive missing from SMART snapshot".into());
            }
        }
    }
    if tool_absent {
        Availability::Unsupported
    } else {
        Availability::Available
    }
}

fn unsupported_smart(drive: &mut Drive, at: i64) {
    drive.smart = SmartStatus {
        availability: Availability::Unsupported,
        passed: None,
        observed_at_ms: at,
        detail: Some("SMART unsupported".into()),
    };
    drive.available_spare = blank_metric("%", at, Availability::Unsupported, "SMART unsupported");
    drive.spare_threshold_percent = None;
    drive.media_errors = blank_metric("count", at, Availability::Unsupported, "SMART unsupported");
    drive.media_critical = false;
    drive.temperature = blank_metric("C", at, Availability::Unsupported, "SMART unsupported");
}

fn sensor_group(
    root: &Path,
    at: i64,
    timeout: Duration,
) -> (
    Vec<NamedMetric>,
    Vec<NamedMetric>,
    Availability,
    Availability,
) {
    let hwmon = child_path(root, "sys/class/hwmon");
    let thermal = child_path(root, "sys/class/thermal");
    let mut temps = Vec::new();
    let mut fans = Vec::new();
    let mut temp_availability = Availability::Unsupported;
    let mut fan_availability = Availability::Unsupported;
    match read_dir_names(&hwmon) {
        Err(ProbeError::Missing) => {}
        Err(error) => {
            temp_availability = availability_of(&error);
            fan_availability = availability_of(&error);
        }
        Ok(chips) => {
            for chip in chips {
                let dir = hwmon.join(&chip);
                let name = sys_string(&dir.join("name"), timeout).unwrap_or(chip);
                for index in 1..=8 {
                    if let Some(raw) = sys_string(&dir.join(format!("temp{index}_input")), timeout)
                    {
                        temp_availability = Availability::Available;
                        let label = sys_string(&dir.join(format!("temp{index}_label")), timeout)
                            .unwrap_or_else(|| format!("{name} temp{index}"));
                        temps.push(named_milli(&format!("{name} {label}"), &raw, at));
                    }
                    if let Some(raw) = sys_string(&dir.join(format!("fan{index}_input")), timeout) {
                        fan_availability = Availability::Available;
                        fans.push(named_count(&format!("{name} fan{index}"), &raw, "rpm", at));
                    }
                }
            }
        }
    }
    if let Ok(zones) = read_dir_names(&thermal) {
        for zone in zones
            .into_iter()
            .filter(|name| name.starts_with("thermal_zone"))
        {
            let dir = thermal.join(&zone);
            if let Some(raw) = sys_string(&dir.join("temp"), timeout) {
                temp_availability = Availability::Available;
                let kind = sys_string(&dir.join("type"), timeout).unwrap_or(zone);
                temps.push(named_milli(&kind, &raw, at));
            }
        }
    }
    (temps, fans, temp_availability, fan_availability)
}

fn named_milli(name: &str, raw: &str, at: i64) -> NamedMetric {
    let metric = match raw.trim().parse::<f64>() {
        Ok(value) if value.is_finite() => {
            metric("C", at, Availability::Available, Some(value / 1000.0), None)
        }
        _ => blank_metric("C", at, Availability::Error, "malformed"),
    };
    NamedMetric {
        name: name.into(),
        metric,
    }
}

fn named_count(name: &str, raw: &str, unit: &str, at: i64) -> NamedMetric {
    let metric = match raw.trim().parse::<f64>() {
        Ok(value) if value.is_finite() => {
            metric(unit, at, Availability::Available, Some(value), None)
        }
        _ => blank_metric(unit, at, Availability::Error, "malformed"),
    };
    NamedMetric {
        name: name.into(),
        metric,
    }
}

fn pick_cpu_temp(temps: &[NamedMetric], at: i64) -> Metric {
    temps
        .iter()
        .find(|item| {
            let name = item.name.to_ascii_lowercase();
            name.contains("package")
                || name.contains("tdie")
                || name.contains("tctl")
                || name.contains("cpu")
                || name.contains("x86_pkg")
        })
        .map(|item| item.metric.clone())
        .unwrap_or_else(|| {
            blank_metric(
                "C",
                at,
                Availability::Unsupported,
                "no cpu temperature sensor",
            )
        })
}

fn load_filesystems(root: &Path, at: i64, timeout: Duration) -> (Vec<Filesystem>, Availability) {
    let mounts = match read_text(&child_path(root, "proc/self/mountinfo"), timeout) {
        Ok(text) => parse_mountinfo(&text),
        Err(mountinfo) => match read_text(&child_path(root, "proc/mounts"), timeout) {
            Ok(text) => parse_mounts(&text),
            Err(_) => return (vec![], availability_of(&mountinfo)),
        },
    };
    let included: Vec<_> = mounts
        .into_iter()
        .filter(|mount| included_fs(&mount.fstype))
        .collect();
    if included.is_empty() {
        return (vec![], Availability::Unsupported);
    }
    let caps = if root == Path::new("/") {
        None
    } else {
        Some(
            read_text(&child_path(root, "sys/fs/factory-mountstat"), timeout)
                .map(|text| parse_mountstat(&text))
                .unwrap_or_default(),
        )
    };
    let filesystems = included
        .into_iter()
        .map(|mount| {
            let cap = if root == Path::new("/") {
                stat_mount(Path::new(&mount.mountpoint))
            } else {
                caps.as_ref()
                    .and_then(|caps| caps.get(&mount.mountpoint).cloned())
            };
            filesystem_from(&mount, cap.as_ref(), at)
        })
        .collect();
    (filesystems, Availability::Available)
}

fn load_slow(root: &Path, at: i64, timeout: Duration) -> Slow {
    let (mut filesystems, filesystems_availability) = load_filesystems(root, at, timeout);
    let _ = &mut filesystems;
    let (mut drives, drives_availability) = load_drives(root, at, timeout);
    let smart = if drives.is_empty() && drives_availability == Availability::Unsupported {
        Availability::Unsupported
    } else {
        apply_smart(&mut drives, root, at, timeout)
    };
    let (temperatures, fans, temperatures_availability, fans_availability) =
        sensor_group(root, at, timeout);
    let cpu_temp = pick_cpu_temp(&temperatures, at);
    Slow {
        at_ms: at,
        filesystems,
        filesystems_availability,
        drives,
        drives_availability,
        smart,
        cooling: Cooling {
            temperatures,
            fans,
            temperatures_availability,
            fans_availability,
        },
        cpu_temp,
    }
}

fn mem_metrics(text: Result<String, ProbeError>, at: i64) -> Ram {
    let map = match text {
        Ok(text) => parse_meminfo(&text),
        Err(error) => {
            let metric = failed("bytes", at, &error);
            return Ram {
                total: metric.clone(),
                available: metric.clone(),
                used: metric.clone(),
                swap_total: metric.clone(),
                swap_free: metric,
            };
        }
    };
    let total = map.get("MemTotal").copied();
    let available = map.get("MemAvailable").copied();
    let used = match (total, available) {
        (Some(total), Some(available)) => Some(total.saturating_sub(available)),
        _ => None,
    };
    Ram {
        total: bytes_metric(at, total),
        available: bytes_metric(at, available),
        used: bytes_metric(at, used),
        swap_total: bytes_metric(at, map.get("SwapTotal").copied()),
        swap_free: bytes_metric(at, map.get("SwapFree").copied()),
    }
}

fn load_triple(text: &str) -> Option<(f64, f64, f64)> {
    let mut parts = text.split_whitespace();
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ))
}

fn load_metrics(text: Result<String, ProbeError>, at: i64) -> (Metric, Metric, Metric) {
    let parsed = match text {
        Ok(text) => load_triple(&text),
        Err(error) => {
            let metric = failed("load", at, &error);
            return (metric.clone(), metric.clone(), metric);
        }
    };
    match parsed {
        Some((one, five, fifteen)) => (
            metric("load", at, Availability::Available, Some(one), None),
            metric("load", at, Availability::Available, Some(five), None),
            metric("load", at, Availability::Available, Some(fifteen), None),
        ),
        None => {
            let metric = blank_metric("load", at, Availability::Error, "malformed");
            (metric.clone(), metric.clone(), metric)
        }
    }
}

fn uptime_metric(text: Result<String, ProbeError>, at: i64) -> Metric {
    match text {
        Ok(text) => match text
            .split_whitespace()
            .next()
            .and_then(|field| field.parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value >= 0.0)
        {
            Some(seconds) => metric("s", at, Availability::Available, Some(seconds), None),
            None => blank_metric("s", at, Availability::Error, "malformed"),
        },
        Err(error) => failed("s", at, &error),
    }
}

fn waiting_rate(unit: &str, at: i64) -> Metric {
    blank_metric(unit, at, Availability::Stale, "waiting for a second sample")
}

fn cpu_rates(
    text: Result<String, ProbeError>,
    boot_id: Option<String>,
    window: &mut Window,
    at: i64,
) -> (Metric, Metric, bool) {
    let parsed = match &text {
        Ok(text) => parse_cpu(text),
        Err(error) => return (failed("%", at, error), failed("%", at, error), false),
    };
    let Some(next) = parsed else {
        return (
            blank_metric("%", at, Availability::Error, "malformed"),
            blank_metric("%", at, Availability::Error, "malformed"),
            false,
        );
    };
    let elapsed = window.at_ms.map(|then| at.saturating_sub(then));
    let gap = elapsed.is_some_and(|elapsed| elapsed > FAST_INTERVAL_MS * 2);
    let boot_changed = match (&window.boot_id, &boot_id) {
        (Some(previous), Some(next_id)) => previous != next_id,
        (Some(_), None) | (None, Some(_)) if window.cpu.is_some() => true,
        _ => false,
    };
    let decreased = window
        .cpu
        .as_ref()
        .is_some_and(|prev| counter_decreased(prev, &next));
    let rates = if decreased
        || gap
        || boot_changed
        || window.cpu.is_none()
        || elapsed.is_none_or(|elapsed| elapsed <= 0)
    {
        None
    } else if let Some(prev) = window.cpu {
        let busy = (next.user - prev.user)
            + (next.nice - prev.nice)
            + (next.system - prev.system)
            + (next.irq - prev.irq)
            + (next.softirq - prev.softirq)
            + (next.steal - prev.steal);
        let iowait = next.iowait - prev.iowait;
        let idle = next.idle - prev.idle;
        let total = busy + iowait + idle;
        percent_delta(0, busy, total).zip(percent_delta(0, iowait, total))
    } else {
        None
    };
    window.cpu = Some(next);
    window.boot_id = boot_id;
    window.at_ms = Some(at);
    match rates {
        Some((util, iowait)) => (
            metric("%", at, Availability::Available, Some(util), None),
            metric("%", at, Availability::Available, Some(iowait), None),
            true,
        ),
        None => (waiting_rate("%", at), waiting_rate("%", at), true),
    }
}

fn io_rates(
    current: Result<BTreeMap<String, (u64, u64)>, ProbeError>,
    previous: &mut BTreeMap<String, (u64, u64)>,
    elapsed_ms: Option<i64>,
    scale: f64,
    at: i64,
    empty_detail: &str,
) -> (Metric, Metric) {
    let next = match current {
        Ok(next) => next,
        Err(error) => return (failed("B/s", at, &error), failed("B/s", at, &error)),
    };
    if next.is_empty() {
        previous.clear();
        return (
            blank_metric("B/s", at, Availability::Unsupported, empty_detail),
            blank_metric("B/s", at, Availability::Unsupported, empty_detail),
        );
    }
    let rates = elapsed_ms.and_then(|elapsed| pair_rate(previous, &next, elapsed, scale));
    *previous = next;
    match rates {
        Some((read, write)) => (
            metric("B/s", at, Availability::Available, Some(read), None),
            metric("B/s", at, Availability::Available, Some(write), None),
        ),
        None => (waiting_rate("B/s", at), waiting_rate("B/s", at)),
    }
}

struct BackupFields {
    last_success_ms: Option<i64>,
    last_attempt_ms: Option<i64>,
    error: Option<String>,
}

fn parse_backup(bytes: &[u8]) -> Option<Vec<BackupFields>> {
    let map: BTreeMap<String, serde_json::Value> = serde_json::from_slice(bytes).ok()?;
    map.into_values()
        .map(|entry| {
            entry.is_object().then(|| BackupFields {
                last_success_ms: entry["last_success_ms"].as_i64(),
                last_attempt_ms: entry["last_attempt_ms"].as_i64(),
                error: entry["error"].as_str().map(str::to_owned),
            })
        })
        .collect()
}

fn load_backup(path: &Path, at: i64, timeout: Duration) -> BackupView {
    match read_limited(path, timeout) {
        Err(error) => BackupView {
            availability: availability_of(&error),
            last_success_ms: None,
            last_attempt_ms: None,
            error: None,
            observed_at_ms: at,
        },
        Ok(bytes) => match parse_backup(&bytes).and_then(|entries| entries.into_iter().next()) {
            Some(fields) => BackupView {
                availability: Availability::Available,
                last_success_ms: fields.last_success_ms,
                last_attempt_ms: fields.last_attempt_ms,
                error: fields.error,
                observed_at_ms: at,
            },
            None => BackupView {
                availability: Availability::Error,
                last_success_ms: None,
                last_attempt_ms: None,
                error: None,
                observed_at_ms: at,
            },
        },
    }
}

fn load_reboot(path: &Path, _at: i64, timeout: Duration) -> RebootView {
    let denied = |detail: String| RebootView {
        availability: Availability::PermissionDenied,
        reboot_required: None,
        pending_since_ms: None,
        days_pending: None,
        consecutive_skips: None,
        alert_due: None,
        last_check_ms: None,
        last_decision: None,
        detail: Some(detail),
    };
    match read_limited(path, timeout) {
        Err(ProbeError::Missing) => denied("missing".into()),
        Err(ProbeError::Denied) => denied("permission denied".into()),
        Err(error) => RebootView {
            availability: availability_of(&error),
            reboot_required: None,
            pending_since_ms: None,
            days_pending: None,
            consecutive_skips: None,
            alert_due: None,
            last_check_ms: None,
            last_decision: None,
            detail: Some(detail_of(&error)),
        },
        Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(value) if value.is_object() => RebootView {
                availability: Availability::Available,
                reboot_required: value["reboot_required"].as_bool(),
                pending_since_ms: value["pending_since_ms"].as_i64(),
                days_pending: value["days_pending"].as_i64(),
                consecutive_skips: value["consecutive_skips"].as_i64(),
                alert_due: value["alert_due"].as_bool(),
                last_check_ms: value["last_check_ms"].as_i64(),
                last_decision: value["last_decision"].as_str().map(str::to_owned),
                detail: None,
            },
            _ => RebootView {
                availability: Availability::Error,
                reboot_required: None,
                pending_since_ms: None,
                days_pending: None,
                consecutive_skips: None,
                alert_due: None,
                last_check_ms: None,
                last_decision: None,
                detail: Some("malformed".into()),
            },
        },
    }
}

fn gpu_slots(gpu: Option<&GpuCurrent>, at: i64) -> Vec<GpuSlot> {
    let Some(gpu) = gpu else {
        let metric = blank_metric("metric", at, Availability::Error, "meter gpu unavailable");
        return vec![GpuSlot {
            index: 0,
            memory_used: metric.clone(),
            memory_total: metric.clone(),
            utilization: metric.clone(),
            temperature: metric.clone(),
            power: metric,
        }];
    };
    let stale = at.saturating_sub(gpu.ts_ms) > FAST_INTERVAL_MS * 2;
    let availability = if stale {
        Availability::Stale
    } else {
        Availability::Available
    };
    let one = |unit: &str, value: f64| {
        metric(
            unit,
            gpu.ts_ms,
            availability,
            Some(value),
            stale.then(|| "meter gpu sample is stale".to_string()),
        )
    };
    vec![GpuSlot {
        index: 0,
        memory_used: one("MiB", gpu.memory_used_mib),
        memory_total: one("MiB", gpu.memory_total_mib),
        utilization: one("%", gpu.utilization_percent),
        temperature: one("C", gpu.temperature_c),
        power: one("W", gpu.power_w),
    }]
}

fn ups_summary(ups: Option<&UpsCurrent>, at: i64) -> UpsSummary {
    let Some(ups) = ups else {
        return UpsSummary {
            href: "/ups".into(),
            availability: Availability::Error,
            status: None,
            charge_percent: None,
            observed_at_ms: at,
            detail: Some("no UPS sample".into()),
        };
    };
    let stale = at.saturating_sub(ups.ts_ms) > 20_000;
    UpsSummary {
        href: "/ups".into(),
        availability: if stale {
            Availability::Stale
        } else {
            Availability::Available
        },
        status: if stale { None } else { ups.status.clone() },
        charge_percent: if stale { None } else { ups.charge_percent },
        observed_at_ms: ups.ts_ms,
        detail: stale.then(|| ups.status.clone().unwrap_or_else(|| "stale".into())),
    }
}

pub fn sample(root: &Path, sampler: &mut Sampler, inputs: &Inputs) -> DeviceView {
    sample_timeout(root, sampler, inputs, DEFAULT_TIMEOUT)
}

pub fn sample_timeout(
    root: &Path,
    sampler: &mut Sampler,
    inputs: &Inputs,
    timeout: Duration,
) -> DeviceView {
    let at = inputs.now_ms;
    let stat = read_text(&child_path(root, "proc/stat"), timeout);
    let boot_text = read_text(&child_path(root, "proc/sys/kernel/random/boot_id"), timeout).ok();
    let boot_id = boot_text
        .as_ref()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    let previous_at = sampler.window.at_ms;
    let (utilization, iowait, fast_ok) = cpu_rates(stat, boot_id.clone(), &mut sampler.window, at);
    if fast_ok {
        sampler.last_fast_ms = Some(at);
    }
    let (load1, load5, load15) =
        load_metrics(read_text(&child_path(root, "proc/loadavg"), timeout), at);
    let memory = mem_metrics(read_text(&child_path(root, "proc/meminfo"), timeout), at);
    let uptime = uptime_metric(read_text(&child_path(root, "proc/uptime"), timeout), at);
    let hostname = read_text(&child_path(root, "proc/sys/kernel/hostname"), timeout)
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    let disks = match read_text(&child_path(root, "proc/diskstats"), timeout) {
        Ok(text) => match physical_disks(root) {
            Ok(names) => {
                let mut all = parse_diskstats(&text);
                all.retain(|name, _| names.iter().any(|physical| physical == name));
                Ok(all)
            }
            Err(error) => Err(error),
        },
        Err(error) => Err(error),
    };
    let (disk_read, disk_write) = io_rates(
        disks,
        &mut sampler.window.disks,
        previous_at.map(|then| at.saturating_sub(then)),
        512.0,
        at,
        "no physical disks",
    );
    let nets =
        read_text(&child_path(root, "proc/net/dev"), timeout).map(|text| parse_netdev(&text));
    let (net_rx, net_tx) = io_rates(
        nets,
        &mut sampler.window.nets,
        previous_at.map(|then| at.saturating_sub(then)),
        1.0,
        at,
        "no network interfaces",
    );
    let refresh_slow = sampler
        .slow
        .as_ref()
        .is_none_or(|slow| at.saturating_sub(slow.at_ms) >= SLOW_INTERVAL_MS);
    if refresh_slow {
        sampler.slow = Some(load_slow(root, at, timeout));
    }
    let slow = sampler.slow.as_ref().expect("slow inventory");
    let mut warnings = Vec::new();
    if !fast_ok {
        warnings.push(format!(
            "cpu: {}",
            utilization
                .detail
                .clone()
                .unwrap_or_else(|| "collector failed".into())
        ));
    }
    let reboot = load_reboot(&inputs.reboot_path, at, timeout);
    if reboot.availability == Availability::PermissionDenied {
        warnings.push("reboot: status is not readable".into());
    }
    let backup = load_backup(&inputs.backup_path, at, timeout);
    let mut host = HostSnapshot {
        device_id: DEVICE_ID.into(),
        observed_at_ms: at,
        identity: HostIdentity {
            hostname,
            boot_id,
            uptime,
        },
        cpu: Cpu {
            utilization,
            iowait,
            load1,
            load5,
            load15,
            temperature: slow.cpu_temp.clone(),
        },
        memory,
        gpus: gpu_slots(inputs.gpu.as_ref(), at),
        filesystems: slow.filesystems.clone(),
        drives: slow.drives.clone(),
        disk_io: DiskIo {
            read: disk_read,
            write: disk_write,
        },
        network: Network {
            rx: net_rx,
            tx: net_tx,
        },
        cooling: slow.cooling.clone(),
        maintenance: Maintenance {
            services: inputs.services.clone(),
            backup,
            clock: ClockView {
                synchronized: Some(inputs.clock_synchronized),
                availability: Availability::Available,
                observed_at_ms: at,
            },
            reboot,
            ups: ups_summary(inputs.ups.as_ref(), at),
        },
        collector: CollectorHealth {
            fast_interval_ms: FAST_INTERVAL_MS,
            slow_interval_ms: SLOW_INTERVAL_MS,
            last_fast_ms: sampler.last_fast_ms,
            last_slow_ms: Some(slow.at_ms),
            fast_ok,
            filesystems: slow.filesystems_availability,
            drives: slow.drives_availability,
            smart: slow.smart,
            detail: (!fast_ok).then(|| "fast sample failed".into()),
        },
        health: HealthReport {
            status: HealthStatus::Unknown,
            reasons: vec![],
        },
    };
    host.health = assess(&host, at);
    if inputs.gpu.is_none() {
        warnings.push("gpu: meter sample unavailable".into());
    }
    DeviceView {
        generated_at_ms: at,
        warnings,
        device: host,
    }
}

pub fn known_device(id: &str) -> bool {
    id == DEVICE_ID
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::GpuCurrent;
    use std::os::unix::fs::PermissionsExt;

    fn write(root: &(impl AsRef<Path> + ?Sized), rel: &str, body: &str) {
        let path = root.as_ref().join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    fn fixture(root: &Path) {
        write(root, "proc/stat", "cpu  100 0 100 800 0 0 0 0 0 0\n");
        write(
            root,
            "proc/meminfo",
            "MemTotal:       1000000 kB\nMemAvailable:    250000 kB\nSwapTotal:        0 kB\nSwapFree:         0 kB\n",
        );
        write(root, "proc/uptime", "1000.0 800.0\n");
        write(root, "proc/loadavg", "1.5 1.0 0.5 1/10 1\n");
        write(
            root,
            "proc/diskstats",
            " 259 0 nvme0n1 1 0 100 0 1 0 50 0 0 0 0 0\n 259 1 nvme0n1p1 1 0 10 0 1 0 5 0 0 0 0 0\n",
        );
        write(
            root,
            "proc/net/dev",
            "Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo: 9 0 0 0 0 0 0 0 9 0 0 0 0 0 0 0\n  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\n",
        );
        write(root, "proc/sys/kernel/hostname", "factory-gpu\n");
        write(root, "proc/sys/kernel/random/boot_id", "boot-a\n");
        write(
            root,
            "proc/self/mountinfo",
            "36 35 98:0 / / rw - ext4 /dev/nvme0n1p2 rw\n37 35 0:5 / /proc rw - proc proc rw\n38 35 0:6 / /sys rw - sysfs sysfs rw\n39 35 0:7 / /run rw - tmpfs tmpfs rw\n40 35 0:8 / /dev rw - devtmpfs devtmpfs rw\n41 35 98:1 / /boot rw - ext4 /dev/nvme0n1p1 rw\n42 35 0:9 / /snap/x rw - squashfs /dev/loop0 rw\n43 35 0:10 / /overlay rw - overlay overlay rw\n",
        );
        write(
            root,
            "sys/fs/factory-mountstat",
            "/\t1000\t400\t100\t20\n/boot\t500\t100\t10\t1\n",
        );
        write(root, "sys/block/nvme0n1/size", "2048\n");
        write(root, "sys/block/nvme0n1/device/model", "Test SSD\n");
        write(root, "sys/block/nvme0n1/device/wwid", "wwn-abc\n");
        write(root, "sys/block/nvme0n1/device/serial", "SER\n");
        write(root, "sys/block/nvme0n1p1/partition", "1\n");
        write(root, "sys/block/loop0/size", "10\n");
        write(root, "sys/class/hwmon/hwmon0/name", "k10temp\n");
        write(root, "sys/class/hwmon/hwmon0/temp1_input", "45000\n");
        write(root, "sys/class/hwmon/hwmon0/temp1_label", "Tdie\n");
        write(root, "sys/class/hwmon/hwmon0/fan1_input", "1200\n");
        write(
            root,
            "var/lib/factory-devices/smart.json",
            r#"{"observed_at_ms":10,"drives":[{"id":"wwn-abc","kernel":"nvme0n1","passed":true,"available_spare_percent":100,"spare_threshold_percent":10,"media_errors":0,"media_critical":false,"temperature_c":34}]}"#,
        );
        write(
            root,
            "var/lib/factory-backup-status/status.json",
            r#"{"meter":{"last_success_ms":10,"last_attempt_ms":12,"error":null}}"#,
        );
        write(
            root,
            "var/lib/factory-reboot/status.json",
            r#"{"reboot_required":true,"pending_since_ms":1000,"days_pending":3,"consecutive_skips":2,"alert_due":false,"last_check_ms":2000,"last_decision":"skipped"}"#,
        );
    }

    fn inputs(root: &Path, now: i64) -> Inputs {
        Inputs {
            now_ms: now,
            gpu: Some(GpuCurrent {
                memory_used_mib: 1000.0,
                memory_total_mib: 12000.0,
                utilization_percent: 10.0,
                temperature_c: 50.0,
                power_w: 40.0,
                ts_ms: now,
            }),
            ups: None,
            services: vec![],
            backup_path: root.join("var/lib/factory-backup-status/status.json"),
            reboot_path: root.join("var/lib/factory-reboot/status.json"),
            clock_synchronized: true,
        }
    }

    fn advance(root: &Path) {
        write(&root, "proc/stat", "cpu  200 0 200 1400 100 0 0 0 0 0\n");
        write(
            &root,
            "proc/diskstats",
            " 259 0 nvme0n1 2 0 300 0 2 0 250 0 0 0 0 0\n",
        );
        write(
            &root,
            "proc/net/dev",
            "  lo: 9 0 0 0 0 0 0 0 9 0 0 0 0 0 0 0\n  eth0: 4000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\n",
        );
    }

    #[test]
    fn first_sample_rates_are_null_and_second_sample_is_exact() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path());
        let mut sampler = Sampler::default();
        let first = sample(root.path(), &mut sampler, &inputs(root.path(), 1_000));
        assert_eq!(first.device.cpu.utilization.value, None);
        assert_ne!(first.device.cpu.utilization.value, Some(0.0));
        assert_eq!(
            first.device.cpu.utilization.availability,
            Availability::Stale
        );
        assert_eq!(first.device.health.status, HealthStatus::Unknown);
        assert_eq!(first.device.memory.total.value, Some(1_000_000.0 * 1024.0));
        assert_eq!(first.device.memory.used.value, Some(750_000.0 * 1024.0));
        assert_eq!(first.device.memory.swap_total.value, Some(0.0));
        assert_eq!(
            first.device.identity.hostname.as_deref(),
            Some("factory-gpu")
        );
        assert_eq!(first.device.identity.uptime.value, Some(1000.0));
        assert_eq!(first.device.filesystems.len(), 2);
        assert!(
            first
                .device
                .filesystems
                .iter()
                .all(|fs| fs.fstype == "ext4")
        );
        assert_eq!(first.device.drives.len(), 1);
        assert_eq!(first.device.drives[0].id, "wwn-abc");
        assert_eq!(first.device.drives[0].smart.passed, Some(true));
        assert_eq!(first.device.cpu.temperature.value, Some(45.0));
        assert_eq!(first.device.cooling.fans.len(), 1);
        assert_eq!(first.device.gpus[0].utilization.value, Some(10.0));
        assert_eq!(first.device.maintenance.reboot.days_pending, Some(3));
        assert_eq!(first.device.maintenance.reboot.reboot_required, Some(true));
        assert_eq!(first.device.maintenance.backup.last_success_ms, Some(10));
        assert_eq!(first.device.maintenance.ups.href, "/ups");
        assert!(first.device.maintenance.ups.charge_percent.is_none());

        advance(root.path());
        let second = sample(root.path(), &mut sampler, &inputs(root.path(), 16_000));
        let util = second.device.cpu.utilization.value.unwrap();
        assert!((util - 200.0 / 9.0).abs() < 1e-9, "{util}");
        let iowait = second.device.cpu.iowait.value.unwrap();
        assert!((iowait - 100.0 / 9.0).abs() < 1e-9, "{iowait}");
        let read = second.device.disk_io.read.value.unwrap();
        assert!((read - 200.0 * 512.0 / 15.0).abs() < 1e-6, "{read}");
        assert_eq!(
            second.device.disk_io.write.value,
            Some(200.0 * 512.0 / 15.0)
        );
        assert_eq!(second.device.network.rx.value, Some(3000.0 / 15.0));
        assert_eq!(second.device.network.tx.value, Some(0.0));
        assert_eq!(second.device.health.status, HealthStatus::Healthy);
    }

    #[test]
    fn counter_reset_boot_change_and_gap_do_not_invent_a_rate() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path());
        let mut sampler = Sampler::default();
        sample(root.path(), &mut sampler, &inputs(root.path(), 0));
        advance(root.path());
        let second = sample(root.path(), &mut sampler, &inputs(root.path(), 15_000));
        assert!(second.device.cpu.utilization.value.is_some());
        write(&root, "proc/stat", "cpu  10 0 10 10 0 0 0 0 0 0\n");
        let reset = sample(root.path(), &mut sampler, &inputs(root.path(), 30_000));
        assert_eq!(reset.device.cpu.utilization.value, None);
        write(&root, "proc/stat", "cpu  110 0 10 110 0 0 0 0 0 0\n");
        let recovered = sample(root.path(), &mut sampler, &inputs(root.path(), 45_000));
        assert!((recovered.device.cpu.utilization.value.unwrap() - 50.0).abs() < 1e-9);

        write(&root, "proc/sys/kernel/random/boot_id", "boot-b\n");
        write(&root, "proc/stat", "cpu  210 0 10 210 0 0 0 0 0 0\n");
        let reboot = sample(root.path(), &mut sampler, &inputs(root.path(), 60_000));
        assert_eq!(reboot.device.cpu.utilization.value, None);
        assert_eq!(reboot.device.identity.boot_id.as_deref(), Some("boot-b"));

        write(&root, "proc/stat", "cpu  310 0 10 310 0 0 0 0 0 0\n");
        let after = sample(root.path(), &mut sampler, &inputs(root.path(), 75_000));
        assert!(after.device.cpu.utilization.value.is_some());
        write(&root, "proc/stat", "cpu  1000 0 10 1000 0 0 0 0 0 0\n");
        let gap = sample(
            root.path(),
            &mut sampler,
            &inputs(root.path(), 75_000 + 60_000),
        );
        assert_eq!(gap.device.cpu.utilization.value, None);
    }

    #[test]
    fn partial_failure_keeps_good_readings_and_filters_mounts() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path());
        let mut sampler = Sampler::default();
        sample(root.path(), &mut sampler, &inputs(root.path(), 0));
        advance(root.path());
        write(&root, "proc/meminfo", "this is not meminfo\n");
        let view = sample(root.path(), &mut sampler, &inputs(root.path(), 15_000));
        assert!(view.device.cpu.utilization.value.is_some());
        assert_eq!(view.device.memory.total.value, None);
        assert_ne!(view.device.memory.total.value, Some(0.0));
        assert_eq!(view.device.memory.total.availability, Availability::Error);
        assert!(
            view.device
                .filesystems
                .iter()
                .any(|fs| fs.mountpoint == "/")
        );
        assert!(
            view.device
                .filesystems
                .iter()
                .any(|fs| fs.mountpoint == "/boot")
        );
        assert!(view.device.filesystems.iter().all(|fs| {
            !["proc", "sysfs", "tmpfs", "devtmpfs", "squashfs", "overlay"]
                .contains(&fs.fstype.as_str())
        }));
    }

    #[test]
    fn permission_denial_malformed_reboot_and_absent_sensors() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path());
        let reboot = root.path().join("var/lib/factory-reboot/status.json");
        fs::set_permissions(&reboot, fs::Permissions::from_mode(0o000)).unwrap();
        let mut sampler = Sampler::default();
        sample(root.path(), &mut sampler, &inputs(root.path(), 0));
        advance(root.path());
        let denied = sample(root.path(), &mut sampler, &inputs(root.path(), 15_000));
        assert_eq!(
            denied.device.maintenance.reboot.availability,
            Availability::PermissionDenied
        );
        assert_eq!(denied.device.maintenance.reboot.days_pending, None);
        assert_eq!(denied.device.maintenance.reboot.consecutive_skips, None);
        assert_ne!(denied.device.health.status, HealthStatus::Healthy);
        fs::set_permissions(&reboot, fs::Permissions::from_mode(0o644)).unwrap();
        fs::remove_file(&reboot).unwrap();
        let missing = sample(root.path(), &mut sampler, &inputs(root.path(), 30_000));
        assert_eq!(
            missing.device.maintenance.reboot.availability,
            Availability::PermissionDenied
        );
        assert!(missing.device.maintenance.reboot.days_pending.is_none());

        write(&root, "var/lib/factory-reboot/status.json", "not-json");
        let malformed = sample(root.path(), &mut sampler, &inputs(root.path(), 45_000));
        assert_eq!(
            malformed.device.maintenance.reboot.availability,
            Availability::Error
        );
        assert!(
            malformed
                .device
                .maintenance
                .reboot
                .reboot_required
                .is_none()
        );

        fs::remove_dir_all(root.path().join("sys/class/hwmon")).unwrap();
        write(
            &root,
            "var/lib/factory-devices/smart.json",
            r#"{"tool":"absent","drives":[]}"#,
        );
        write(
            &root,
            "var/lib/factory-reboot/status.json",
            r#"{"reboot_required":false,"pending_since_ms":null,"days_pending":0,"consecutive_skips":0,"alert_due":false,"last_check_ms":1,"last_decision":"not-needed"}"#,
        );
        let quiet = sample(
            root.path(),
            &mut sampler,
            &inputs(root.path(), 45_000 + SLOW_INTERVAL_MS),
        );
        assert_eq!(
            quiet.device.cooling.fans_availability,
            Availability::Unsupported
        );
        assert!(quiet.device.cooling.fans.is_empty());
        assert_eq!(
            quiet.device.cpu.temperature.availability,
            Availability::Unsupported
        );
        assert_eq!(
            quiet.device.drives[0].smart.availability,
            Availability::Unsupported
        );
        assert_eq!(quiet.device.drives[0].smart.passed, None);
        assert_ne!(quiet.device.health.status, HealthStatus::Critical);
    }

    #[test]
    fn smart_failure_spare_and_drive_replacement() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path());
        write(
            &root,
            "var/lib/factory-devices/smart.json",
            r#"{"drives":[{"id":"wwn-abc","passed":false,"available_spare_percent":5,"spare_threshold_percent":10,"media_errors":3,"media_critical":true}]}"#,
        );
        let mut sampler = Sampler::default();
        sample(root.path(), &mut sampler, &inputs(root.path(), 0));
        advance(root.path());
        let failed = sample(root.path(), &mut sampler, &inputs(root.path(), 15_000));
        assert_eq!(failed.device.health.status, HealthStatus::Critical);
        assert!(
            failed
                .device
                .health
                .reasons
                .iter()
                .any(|reason| reason.metric.contains("smart"))
        );
        write(&root, "sys/block/nvme0n1/device/wwid", "wwn-new\n");
        write(
            &root,
            "var/lib/factory-devices/smart.json",
            r#"{"drives":[{"kernel":"nvme0n1","passed":true,"available_spare_percent":99,"spare_threshold_percent":10,"media_errors":0,"media_critical":false}]}"#,
        );
        let replaced = sample(
            root.path(),
            &mut sampler,
            &inputs(root.path(), 15_000 + SLOW_INTERVAL_MS),
        );
        assert_eq!(replaced.device.drives.len(), 1);
        assert_eq!(replaced.device.drives[0].id, "wwn-new");
        assert!(
            replaced
                .device
                .drives
                .iter()
                .all(|drive| drive.id != "wwn-abc")
        );
    }

    #[test]
    fn missing_smart_snapshot_is_permission_denied_and_timeout_is_an_error() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path());
        fs::remove_file(root.path().join("var/lib/factory-devices/smart.json")).unwrap();
        let mut sampler = Sampler::default();
        let view = sample(root.path(), &mut sampler, &inputs(root.path(), 0));
        assert_eq!(view.device.collector.smart, Availability::PermissionDenied);
        assert_eq!(
            view.device.drives[0].smart.availability,
            Availability::PermissionDenied
        );
        assert!(view.device.drives[0].smart.passed.is_none());

        let fifo_root = tempfile::tempdir().unwrap();
        fixture(fifo_root.path());
        let stat = fifo_root.path().join("proc/stat");
        fs::remove_file(&stat).unwrap();
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&stat)
                .status()
                .unwrap()
                .success()
        );
        let timed = sample_timeout(
            fifo_root.path(),
            &mut Sampler::default(),
            &inputs(fifo_root.path(), 5),
            Duration::from_millis(50),
        );
        assert_eq!(
            timed.device.cpu.utilization.availability,
            Availability::Error
        );
        assert_eq!(
            timed.device.cpu.utilization.detail.as_deref(),
            Some("timed out")
        );
        assert_eq!(timed.device.cpu.utilization.value, None);
        assert!(timed.device.memory.total.value.is_some());
        let _writer = fs::File::create(&stat);
    }

    #[test]
    fn thresholds_and_freshen_do_not_keep_stale_numbers_live() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path());
        write(
            &root,
            "sys/fs/factory-mountstat",
            "/\t1000\t960\t100\t96\n/boot\t500\t100\t10\t1\n",
        );
        write(&root, "sys/class/hwmon/hwmon0/temp1_input", "96000\n");
        let mut sampler = Sampler::default();
        sample(root.path(), &mut sampler, &inputs(root.path(), 0));
        advance(root.path());
        let hot = sample(root.path(), &mut sampler, &inputs(root.path(), 15_000));
        assert_eq!(hot.device.health.status, HealthStatus::Critical);
        assert!(
            hot.device
                .health
                .reasons
                .iter()
                .any(|reason| reason.threshold == "95%" || reason.threshold == "95 C")
        );
        let stale = freshen(&hot, 15_000 + FAST_INTERVAL_MS * 2 + 1);
        assert_eq!(stale.device.cpu.utilization.value, None);
        assert_eq!(
            stale.device.cpu.utilization.availability,
            Availability::Stale
        );
        assert_eq!(stale.device.health.status, HealthStatus::Critical);
        let cold = freshen(&hot, 15_000 + SLOW_INTERVAL_MS * 2 + 1);
        assert_eq!(cold.device.filesystems[0].used_percent.value, None);
        assert_ne!(cold.device.health.status, HealthStatus::Healthy);
    }
}
