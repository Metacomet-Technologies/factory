//! Remote device ingest, schema version 1 (docs/devices-ingest.md): request
//! validation, ordering and dedupe, and per-device state. Health is computed here
//! with the phase-1 rules; history goes through `devices_history::record`.
use crate::devices::{
    self, Availability, BackupView, ClockView, CollectorHealth, Cooling, Cpu, DeviceView, DiskIo,
    Drive, Filesystem, HealthReport, HealthStatus, HostIdentity, HostSnapshot, IngestView,
    Maintenance, Metric, NamedMetric, Network, Power, Ram, RebootView, SmartStatus, UpsSummary,
};
use axum::http::StatusCode;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use utoipa::ToSchema;

pub const SCHEMA_VERSIONS: [i64; 1] = [1];
pub const MAX_BODY: usize = 64 * 1024;
/// Transport or collection age beyond this makes a remote device stale (decided 2026-10-17).
pub const REMOTE_STALE_MS: i64 = 45_000;
const MAX_FUTURE_MS: i64 = 60_000;
const EXPIRY_MS: i64 = 2 * 3_600_000;
const MAX_INT: i64 = (1 << 53) - 1;
const MAX_TEXT: usize = 256;
const MAX_AGENT_TEXT: usize = 64;
const RATE_PER_S: f64 = 4.0;
const RATE_BURST: f64 = 8.0;
const CONFLICT_WINDOW_MS: i64 = 5 * 60_000;
const SERVER_OWNED: [&str; 4] = ["health", "gpus", "generated_at_ms", "warnings"];
const WAITING: &str = "waiting for first sample";

/// A refused request: the contract's status, code and message, plus the field when known.
#[derive(Debug, Clone, PartialEq)]
pub struct Rejection {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub field: Option<String>,
}

fn bad(code: &'static str, field: &str, message: impl Into<String>) -> Rejection {
    Rejection {
        status: StatusCode::BAD_REQUEST,
        code,
        message: message.into(),
        field: (!field.is_empty()).then(|| field.to_string()),
    }
}

/// One validated sample. `host` has server-owned parts blank until `view`.
#[derive(Debug, Clone)]
pub struct Sample {
    pub device_id: String,
    pub agent_version: String,
    pub session_id: String,
    pub seq: i64,
    pub observed_at_ms: i64,
    pub sent_at_ms: i64,
    pub host: HostSnapshot,
}

impl Sample {
    pub fn clock_synchronized(&self) -> bool {
        self.host.maintenance.clock.synchronized == Some(true)
    }
}

fn join(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.into()
    } else {
        format!("{path}.{key}")
    }
}

fn field<'a>(
    object: &'a Map<String, Value>,
    path: &str,
    key: &str,
) -> Result<&'a Value, Rejection> {
    object.get(key).ok_or_else(|| {
        let name = join(path, key);
        bad("missing_field", &name, format!("{name} is required"))
    })
}

fn object<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>, Rejection> {
    value
        .as_object()
        .ok_or_else(|| bad("invalid_field", path, format!("{path} must be an object")))
}

fn child<'a>(
    parent: &'a Map<String, Value>,
    path: &str,
    key: &str,
) -> Result<(&'a Map<String, Value>, String), Rejection> {
    let name = join(path, key);
    Ok((object(field(parent, path, key)?, &name)?, name))
}

fn integer(value: &Value, path: &str) -> Result<i64, Rejection> {
    value
        .as_i64()
        .filter(|v| (0..=MAX_INT).contains(v))
        .ok_or_else(|| {
            bad(
                "invalid_field",
                path,
                format!("{path} must be an integer from 0 to 2^53-1"),
            )
        })
}

fn opt_integer(value: &Value, path: &str) -> Result<Option<i64>, Rejection> {
    if value.is_null() {
        Ok(None)
    } else {
        integer(value, path).map(Some)
    }
}

fn text(value: &Value, path: &str, max: usize) -> Result<String, Rejection> {
    let text = value
        .as_str()
        .ok_or_else(|| bad("invalid_field", path, format!("{path} must be a string")))?;
    if text.len() > max {
        return Err(bad(
            "invalid_field",
            path,
            format!("{path} exceeds {max} bytes"),
        ));
    }
    Ok(text.into())
}

fn opt_text(value: &Value, path: &str, max: usize) -> Result<Option<String>, Rejection> {
    if value.is_null() {
        Ok(None)
    } else {
        text(value, path, max).map(Some)
    }
}

fn boolean(value: &Value, path: &str) -> Result<bool, Rejection> {
    value
        .as_bool()
        .ok_or_else(|| bad("invalid_field", path, format!("{path} must be a boolean")))
}

fn opt_boolean(value: &Value, path: &str) -> Result<Option<bool>, Rejection> {
    if value.is_null() {
        Ok(None)
    } else {
        boolean(value, path).map(Some)
    }
}

fn availability(value: &Value, path: &str) -> Result<Availability, Rejection> {
    serde_json::from_value(value.clone()).map_err(|_| {
        bad(
            "invalid_metric",
            path,
            format!("{path} must be available, unsupported, permission_denied, stale or error"),
        )
    })
}

/// Unit, inclusive range, and whether the value must be an integer.
fn bounds(unit: &str) -> (f64, f64, bool) {
    match unit {
        "%" => (0.0, 100.0, false),
        "C" => (-40.0, 150.0, false),
        "bytes" => (0.0, MAX_INT as f64, true),
        "B/s" => (0.0, 1e12, false),
        "count" => (0.0, MAX_INT as f64, true),
        "rpm" => (0.0, 30_000.0, false),
        // load and s
        _ => (0.0, f64::MAX, false),
    }
}

fn range_text(low: f64, high: f64) -> String {
    if high == f64::MAX {
        format!(">= {low}")
    } else {
        format!("{low}-{high}")
    }
}

/// Fields other than availability, observed_at_ms and detail must be null unless available.
fn null_unless_available(
    available: bool,
    fields: &[(&str, &Value)],
    path: &str,
) -> Result<(), Rejection> {
    if available {
        return Ok(());
    }
    for (key, value) in fields {
        if !value.is_null() {
            let name = join(path, key);
            return Err(bad(
                "invalid_metric",
                &name,
                format!("{name} must be null unless availability is available"),
            ));
        }
    }
    Ok(())
}

struct Reader {
    sample_at: i64,
}

impl Reader {
    fn power(&self, root: &Map<String, Value>) -> Result<Option<Power>, Rejection> {
        let Some(value) = root.get("power").filter(|v| !v.is_null()) else {
            return Ok(None);
        };
        let power = object(value, "power")?;
        let get = |key: &str| field(power, "power", key);
        let availability = availability(get("availability")?, "power.availability")?;
        let observed_at_ms = self.not_newer(
            integer(get("observed_at_ms")?, "power.observed_at_ms")?,
            "power",
        )?;
        null_unless_available(
            availability == Availability::Available,
            &[
                ("adapter_online", get("adapter_online")?),
                ("battery_status", get("battery_status")?),
                ("battery_percent", get("battery_percent")?),
                ("battery_power_w", get("battery_power_w")?),
            ],
            "power",
        )?;
        let number = |key: &str, max: f64| -> Result<Option<f64>, Rejection> {
            let value = get(key)?;
            if value.is_null() {
                return Ok(None);
            }
            value
                .as_f64()
                .filter(|n| n.is_finite() && (0.0..=max).contains(n))
                .map(Some)
                .ok_or_else(|| {
                    bad(
                        "invalid_field",
                        &join("power", key),
                        "power value outside range",
                    )
                })
        };
        Ok(Some(Power {
            availability,
            observed_at_ms,
            adapter_online: opt_boolean(get("adapter_online")?, "power.adapter_online")?,
            battery_status: opt_text(get("battery_status")?, "power.battery_status", 64)?,
            battery_percent: number("battery_percent", 100.0)?,
            battery_power_w: number("battery_power_w", 1000.0)?,
            detail: opt_text(get("detail")?, "power.detail", MAX_TEXT)?,
        }))
    }

    fn not_newer(&self, at: i64, path: &str) -> Result<i64, Rejection> {
        if at > self.sample_at {
            let name = join(path, "observed_at_ms");
            return Err(bad(
                "invalid_metric",
                &name,
                format!("{name} is newer than the sample's observed_at_ms"),
            ));
        }
        Ok(at)
    }

    fn metric(
        &self,
        parent: &Map<String, Value>,
        path: &str,
        key: &str,
        unit: &str,
    ) -> Result<Metric, Rejection> {
        let (object, path) = child(parent, path, key)?;
        self.metric_object(object, &path, unit)
    }

    fn metric_object(
        &self,
        object: &Map<String, Value>,
        path: &str,
        unit: &str,
    ) -> Result<Metric, Rejection> {
        let value = field(object, path, "value")?;
        let given = text(field(object, path, "unit")?, &join(path, "unit"), MAX_TEXT)?;
        if given != unit {
            return Err(bad(
                "invalid_metric",
                path,
                format!("{path}: unit {given} is not {unit}"),
            ));
        }
        let observed = integer(
            field(object, path, "observed_at_ms")?,
            &join(path, "observed_at_ms"),
        )?;
        let observed = self.not_newer(observed, path)?;
        let availability = availability(
            field(object, path, "availability")?,
            &join(path, "availability"),
        )?;
        let detail = opt_text(
            field(object, path, "detail")?,
            &join(path, "detail"),
            MAX_TEXT,
        )?;
        let value = match (availability, value) {
            (Availability::Available, Value::Number(number)) => {
                let number = number.as_f64().filter(|n| n.is_finite()).ok_or_else(|| {
                    bad(
                        "invalid_metric",
                        path,
                        format!("{path}: value is not finite"),
                    )
                })?;
                let (low, high, whole) = bounds(unit);
                if number < low || number > high {
                    return Err(bad(
                        "invalid_metric",
                        path,
                        format!("{path}: value {number} outside {}", range_text(low, high)),
                    ));
                }
                if whole && number.fract() != 0.0 {
                    return Err(bad(
                        "invalid_metric",
                        path,
                        format!("{path}: value {number} is not an integer"),
                    ));
                }
                Some(number)
            }
            (Availability::Available, _) => {
                return Err(bad(
                    "invalid_metric",
                    path,
                    format!("{path}: available requires a finite numeric value"),
                ));
            }
            (_, Value::Null) => None,
            (_, _) => {
                return Err(bad(
                    "invalid_metric",
                    path,
                    format!("{path}: value must be null unless availability is available"),
                ));
            }
        };
        Ok(Metric {
            value,
            unit: unit.into(),
            observed_at_ms: observed,
            availability,
            detail,
        })
    }

    fn list<'a>(
        &self,
        parent: &'a Map<String, Value>,
        path: &str,
        key: &str,
        max: usize,
    ) -> Result<(&'a Vec<Value>, String), Rejection> {
        let name = join(path, key);
        let items = field(parent, path, key)?
            .as_array()
            .ok_or_else(|| bad("invalid_field", &name, format!("{name} must be an array")))?;
        if items.len() > max {
            return Err(bad(
                "too_many_items",
                &name,
                format!("{name} has {} items; the limit is {max}", items.len()),
            ));
        }
        Ok((items, name))
    }

    fn named(
        &self,
        parent: &Map<String, Value>,
        path: &str,
        key: &str,
        max: usize,
        unit: &str,
    ) -> Result<Vec<NamedMetric>, Rejection> {
        let (items, name) = self.list(parent, path, key, max)?;
        let mut seen = BTreeSet::new();
        items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let path = format!("{name}[{index}]");
                let item = object(item, &path)?;
                let sensor = text(field(item, &path, "name")?, &join(&path, "name"), MAX_TEXT)?;
                if !seen.insert(sensor.clone()) {
                    let at = join(&path, "name");
                    return Err(bad(
                        "invalid_field",
                        &at,
                        format!("{at} duplicates another sensor"),
                    ));
                }
                Ok(NamedMetric {
                    name: sensor,
                    metric: self.metric(item, &path, "metric", unit)?,
                })
            })
            .collect()
    }

    fn filesystems(&self, root: &Map<String, Value>) -> Result<Vec<Filesystem>, Rejection> {
        let (items, name) = self.list(root, "", "filesystems", 32)?;
        let mut seen = BTreeSet::new();
        items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let path = format!("{name}[{index}]");
                let fs = object(item, &path)?;
                let id = text(field(fs, &path, "id")?, &join(&path, "id"), MAX_TEXT)?;
                if !seen.insert(id.clone()) {
                    let at = join(&path, "id");
                    return Err(bad(
                        "invalid_field",
                        &at,
                        format!("{at} duplicates another filesystem"),
                    ));
                }
                Ok(Filesystem {
                    id,
                    source: text(
                        field(fs, &path, "source")?,
                        &join(&path, "source"),
                        MAX_TEXT,
                    )?,
                    mountpoint: text(
                        field(fs, &path, "mountpoint")?,
                        &join(&path, "mountpoint"),
                        MAX_TEXT,
                    )?,
                    fstype: text(
                        field(fs, &path, "fstype")?,
                        &join(&path, "fstype"),
                        MAX_TEXT,
                    )?,
                    size: self.metric(fs, &path, "size", "bytes")?,
                    used: self.metric(fs, &path, "used", "bytes")?,
                    used_percent: self.metric(fs, &path, "used_percent", "%")?,
                    inodes_used_percent: self.metric(fs, &path, "inodes_used_percent", "%")?,
                })
            })
            .collect()
    }

    fn drives(&self, root: &Map<String, Value>) -> Result<Vec<Drive>, Rejection> {
        let (items, name) = self.list(root, "", "drives", 16)?;
        let mut seen = BTreeSet::new();
        items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let path = format!("{name}[{index}]");
                let drive = object(item, &path)?;
                let id = text(field(drive, &path, "id")?, &join(&path, "id"), MAX_TEXT)?;
                if !seen.insert(id.clone()) {
                    let at = join(&path, "id");
                    return Err(bad(
                        "invalid_field",
                        &at,
                        format!("{at} duplicates another drive"),
                    ));
                }
                let (smart, smart_path) = child(drive, &path, "smart")?;
                let smart_availability = availability(
                    field(smart, &smart_path, "availability")?,
                    &join(&smart_path, "availability"),
                )?;
                let passed = field(smart, &smart_path, "passed")?;
                null_unless_available(
                    smart_availability == Availability::Available,
                    &[("passed", passed)],
                    &smart_path,
                )?;
                let smart_at = integer(
                    field(smart, &smart_path, "observed_at_ms")?,
                    &join(&smart_path, "observed_at_ms"),
                )?;
                let threshold_path = join(&path, "spare_threshold_percent");
                let threshold = field(drive, &path, "spare_threshold_percent")?;
                let threshold = if threshold.is_null() {
                    None
                } else {
                    Some(
                        threshold
                            .as_f64()
                            .filter(|v| (0.0..=100.0).contains(v))
                            .ok_or_else(|| {
                                bad(
                                    "invalid_metric",
                                    &threshold_path,
                                    format!("{threshold_path} must be 0-100 or null"),
                                )
                            })?,
                    )
                };
                Ok(Drive {
                    id,
                    kernel: text(
                        field(drive, &path, "kernel")?,
                        &join(&path, "kernel"),
                        MAX_TEXT,
                    )?,
                    model: opt_text(
                        field(drive, &path, "model")?,
                        &join(&path, "model"),
                        MAX_TEXT,
                    )?,
                    size: self.metric(drive, &path, "size", "bytes")?,
                    smart: SmartStatus {
                        availability: smart_availability,
                        passed: opt_boolean(passed, &join(&smart_path, "passed"))?,
                        observed_at_ms: self.not_newer(smart_at, &smart_path)?,
                        detail: opt_text(
                            field(smart, &smart_path, "detail")?,
                            &join(&smart_path, "detail"),
                            MAX_TEXT,
                        )?,
                    },
                    available_spare: self.metric(drive, &path, "available_spare", "%")?,
                    spare_threshold_percent: threshold,
                    media_errors: self.metric(drive, &path, "media_errors", "count")?,
                    media_critical: boolean(
                        field(drive, &path, "media_critical")?,
                        &join(&path, "media_critical"),
                    )?,
                    temperature: self.metric(drive, &path, "temperature", "C")?,
                    // Not in schema version 1; unclean-shutdown notices stay factory-gpu only.
                    unsafe_shutdowns: None,
                })
            })
            .collect()
    }

    fn maintenance(
        &self,
        root: &Map<String, Value>,
    ) -> Result<(BackupView, ClockView, RebootView), Rejection> {
        let (maintenance, path) = child(root, "", "maintenance")?;
        let (backup, backup_path) = child(maintenance, &path, "backup")?;
        let backup_availability = availability(
            field(backup, &backup_path, "availability")?,
            &join(&backup_path, "availability"),
        )?;
        let success = field(backup, &backup_path, "last_success_ms")?;
        let attempt = field(backup, &backup_path, "last_attempt_ms")?;
        let error = field(backup, &backup_path, "error")?;
        // BackupView has no `detail`, so `error` is one of the fields that must be null.
        null_unless_available(
            backup_availability == Availability::Available,
            &[
                ("last_success_ms", success),
                ("last_attempt_ms", attempt),
                ("error", error),
            ],
            &backup_path,
        )?;
        let backup_at = integer(
            field(backup, &backup_path, "observed_at_ms")?,
            &join(&backup_path, "observed_at_ms"),
        )?;
        let backup = BackupView {
            availability: backup_availability,
            last_success_ms: opt_integer(success, &join(&backup_path, "last_success_ms"))?,
            last_attempt_ms: opt_integer(attempt, &join(&backup_path, "last_attempt_ms"))?,
            error: opt_text(error, &join(&backup_path, "error"), MAX_TEXT)?,
            observed_at_ms: self.not_newer(backup_at, &backup_path)?,
        };
        let (clock, clock_path) = child(maintenance, &path, "clock")?;
        let clock_availability = availability(
            field(clock, &clock_path, "availability")?,
            &join(&clock_path, "availability"),
        )?;
        let synchronized = field(clock, &clock_path, "synchronized")?;
        null_unless_available(
            clock_availability == Availability::Available,
            &[("synchronized", synchronized)],
            &clock_path,
        )?;
        let clock_at = integer(
            field(clock, &clock_path, "observed_at_ms")?,
            &join(&clock_path, "observed_at_ms"),
        )?;
        let clock = ClockView {
            synchronized: opt_boolean(synchronized, &join(&clock_path, "synchronized"))?,
            availability: clock_availability,
            observed_at_ms: self.not_newer(clock_at, &clock_path)?,
        };
        let (reboot, reboot_path) = child(maintenance, &path, "reboot")?;
        let reboot_availability = availability(
            field(reboot, &reboot_path, "availability")?,
            &join(&reboot_path, "availability"),
        )?;
        let keys = [
            "reboot_required",
            "pending_since_ms",
            "days_pending",
            "consecutive_skips",
            "alert_due",
            "last_check_ms",
            "last_decision",
        ];
        let mut values = Vec::with_capacity(keys.len());
        for key in keys {
            values.push((key, field(reboot, &reboot_path, key)?));
        }
        null_unless_available(
            reboot_availability == Availability::Available,
            &values,
            &reboot_path,
        )?;
        let at = |key: &str| join(&reboot_path, key);
        let reboot = RebootView {
            availability: reboot_availability,
            reboot_required: opt_boolean(values[0].1, &at("reboot_required"))?,
            pending_since_ms: opt_integer(values[1].1, &at("pending_since_ms"))?,
            days_pending: opt_integer(values[2].1, &at("days_pending"))?,
            consecutive_skips: opt_integer(values[3].1, &at("consecutive_skips"))?,
            alert_due: opt_boolean(values[4].1, &at("alert_due"))?,
            last_check_ms: opt_integer(values[5].1, &at("last_check_ms"))?,
            last_decision: opt_text(values[6].1, &at("last_decision"), MAX_TEXT)?,
            detail: opt_text(
                field(reboot, &reboot_path, "detail")?,
                &at("detail"),
                MAX_TEXT,
            )?,
        };
        Ok((backup, clock, reboot))
    }

    fn collector(&self, root: &Map<String, Value>) -> Result<CollectorHealth, Rejection> {
        let (collector, path) = child(root, "", "collector")?;
        let at = |key: &str| join(&path, key);
        Ok(CollectorHealth {
            fast_interval_ms: integer(
                field(collector, &path, "fast_interval_ms")?,
                &at("fast_interval_ms"),
            )?,
            slow_interval_ms: integer(
                field(collector, &path, "slow_interval_ms")?,
                &at("slow_interval_ms"),
            )?,
            last_fast_ms: opt_integer(
                field(collector, &path, "last_fast_ms")?,
                &at("last_fast_ms"),
            )?,
            last_slow_ms: opt_integer(
                field(collector, &path, "last_slow_ms")?,
                &at("last_slow_ms"),
            )?,
            fast_ok: boolean(field(collector, &path, "fast_ok")?, &at("fast_ok"))?,
            filesystems: availability(field(collector, &path, "filesystems")?, &at("filesystems"))?,
            drives: availability(field(collector, &path, "drives")?, &at("drives"))?,
            smart: availability(field(collector, &path, "smart")?, &at("smart"))?,
            detail: opt_text(field(collector, &path, "detail")?, &at("detail"), MAX_TEXT)?,
        })
    }
}

/// The workspace parses numbers with arbitrary precision, so `1e400` arrives as a
/// Number. The contract treats any number that overflows f64 as invalid JSON.
fn representable(value: &Value) -> bool {
    match value {
        Value::Number(number) => number.as_f64().is_some_and(f64::is_finite),
        Value::Array(items) => items.iter().all(representable),
        Value::Object(fields) => fields.values().all(representable),
        _ => true,
    }
}

fn valid_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// Validate one request body for `path_id`, in the contract's order: JSON, schema
/// version, server-owned fields, fields, device binding, then future clock skew.
pub fn parse(body: &[u8], path_id: &str, received_at_ms: i64) -> Result<Sample, Rejection> {
    let root: Value = serde_json::from_slice(body).map_err(|error| {
        bad(
            "invalid_json",
            "",
            format!("body is not valid JSON: {error}"),
        )
    })?;
    if !representable(&root) {
        return Err(bad(
            "invalid_json",
            "",
            "body has a number that is not representable",
        ));
    }
    let version = root.get("schema_version");
    if version
        .and_then(Value::as_i64)
        .is_none_or(|v| !SCHEMA_VERSIONS.contains(&v))
    {
        let shown = match version {
            Some(value) => format!("schema_version {value} is not accepted"),
            None => "schema_version is required".into(),
        };
        return Err(bad("unsupported_schema_version", "schema_version", shown));
    }
    let root = root.as_object().expect("schema_version implies an object");
    for key in SERVER_OWNED {
        if root.contains_key(key) {
            return Err(bad(
                "server_owned_field",
                key,
                format!("{key} is server-owned"),
            ));
        }
    }
    if let Some(maintenance) = root.get("maintenance").and_then(Value::as_object) {
        for key in ["services", "ups"] {
            if maintenance.contains_key(key) {
                let name = format!("maintenance.{key}");
                return Err(bad(
                    "server_owned_field",
                    &name,
                    format!("{name} is server-owned"),
                ));
            }
        }
    }
    let device_id = text(field(root, "", "device_id")?, "device_id", MAX_TEXT)?;
    if !crate::device_auth::valid_device_id(&device_id) {
        return Err(bad(
            "invalid_field",
            "device_id",
            "device_id must match ^[a-z0-9][a-z0-9-]{0,62}$",
        ));
    }
    let (agent, _) = child(root, "", "agent")?;
    text(field(agent, "agent", "name")?, "agent.name", MAX_AGENT_TEXT)?;
    let agent_version = text(
        field(agent, "agent", "version")?,
        "agent.version",
        MAX_AGENT_TEXT,
    )?;
    let session_id = text(field(root, "", "session_id")?, "session_id", MAX_TEXT)?;
    if !valid_uuid(&session_id) {
        return Err(bad(
            "invalid_field",
            "session_id",
            "session_id must be a UUID",
        ));
    }
    let seq = integer(field(root, "", "seq")?, "seq")?;
    if seq < 1 {
        return Err(bad("invalid_field", "seq", "seq must be at least 1"));
    }
    let observed_at_ms = integer(field(root, "", "observed_at_ms")?, "observed_at_ms")?;
    let sent_at_ms = integer(field(root, "", "sent_at_ms")?, "sent_at_ms")?;
    let reader = Reader {
        sample_at: observed_at_ms,
    };
    let (identity, _) = child(root, "", "identity")?;
    let identity = HostIdentity {
        hostname: opt_text(
            field(identity, "identity", "hostname")?,
            "identity.hostname",
            MAX_TEXT,
        )?,
        boot_id: opt_text(
            field(identity, "identity", "boot_id")?,
            "identity.boot_id",
            MAX_TEXT,
        )?,
        uptime: reader.metric(identity, "identity", "uptime", "s")?,
    };
    let (cpu, _) = child(root, "", "cpu")?;
    let cpu = Cpu {
        utilization: reader.metric(cpu, "cpu", "utilization", "%")?,
        iowait: reader.metric(cpu, "cpu", "iowait", "%")?,
        load1: reader.metric(cpu, "cpu", "load1", "load")?,
        load5: reader.metric(cpu, "cpu", "load5", "load")?,
        load15: reader.metric(cpu, "cpu", "load15", "load")?,
        temperature: reader.metric(cpu, "cpu", "temperature", "C")?,
    };
    let (memory, _) = child(root, "", "memory")?;
    let memory = Ram {
        total: reader.metric(memory, "memory", "total", "bytes")?,
        available: reader.metric(memory, "memory", "available", "bytes")?,
        used: reader.metric(memory, "memory", "used", "bytes")?,
        swap_total: reader.metric(memory, "memory", "swap_total", "bytes")?,
        swap_free: reader.metric(memory, "memory", "swap_free", "bytes")?,
    };
    let filesystems = reader.filesystems(root)?;
    let drives = reader.drives(root)?;
    let (disk_io, _) = child(root, "", "disk_io")?;
    let disk_io = DiskIo {
        read: reader.metric(disk_io, "disk_io", "read", "B/s")?,
        write: reader.metric(disk_io, "disk_io", "write", "B/s")?,
    };
    let (network, _) = child(root, "", "network")?;
    let network = Network {
        rx: reader.metric(network, "network", "rx", "B/s")?,
        tx: reader.metric(network, "network", "tx", "B/s")?,
    };
    let (cooling, _) = child(root, "", "cooling")?;
    let cooling = Cooling {
        temperatures: reader.named(cooling, "cooling", "temperatures", 64, "C")?,
        fans: reader.named(cooling, "cooling", "fans", 16, "rpm")?,
        temperatures_availability: availability(
            field(cooling, "cooling", "temperatures_availability")?,
            "cooling.temperatures_availability",
        )?,
        fans_availability: availability(
            field(cooling, "cooling", "fans_availability")?,
            "cooling.fans_availability",
        )?,
    };
    let (backup, clock, reboot) = reader.maintenance(root)?;
    let collector = reader.collector(root)?;
    if device_id != path_id {
        return Err(bad(
            "device_mismatch",
            "device_id",
            "body device_id differs from the path",
        ));
    }
    for (name, at) in [
        ("observed_at_ms", observed_at_ms),
        ("sent_at_ms", sent_at_ms),
    ] {
        if at > received_at_ms + MAX_FUTURE_MS {
            return Err(bad(
                "clock_skew",
                name,
                format!(
                    "{name} is {} ms ahead of the server clock",
                    at - received_at_ms
                ),
            ));
        }
    }
    let host = HostSnapshot {
        device_id: device_id.clone(),
        observed_at_ms,
        identity,
        cpu,
        memory,
        gpus: vec![],
        filesystems,
        drives,
        disk_io,
        network,
        cooling,
        power: reader.power(root)?,
        maintenance: Maintenance {
            services: vec![],
            backup,
            clock,
            reboot,
            ups: remote_ups(observed_at_ms),
        },
        collector,
        health: HealthReport {
            status: HealthStatus::Unknown,
            reasons: vec![],
        },
    };
    Ok(Sample {
        device_id,
        agent_version,
        session_id: session_id.to_ascii_lowercase(),
        seq,
        observed_at_ms,
        sent_at_ms,
        host,
    })
}

fn remote_ups(at: i64) -> UpsSummary {
    UpsSummary {
        href: "/ups".into(),
        availability: Availability::Unsupported,
        status: None,
        charge_percent: None,
        observed_at_ms: at,
        detail: Some("UPS is reported only for factory-gpu".into()),
    }
}

/// The last accepted sample's identity. After a restart only the time is known.
#[derive(Debug, Clone, PartialEq)]
pub struct Last {
    pub observed_at_ms: i64,
    pub session_id: Option<String>,
    pub seq: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Ignored(&'static str),
    /// `fresh` samples replace current state; older backlog only writes history.
    Stored {
        fresh: bool,
    },
}

/// Ingest rules 2–5 (rule 1, future skew, is a validation error).
pub fn decide(last: Option<&Last>, sample: &Sample, received_at_ms: i64) -> Outcome {
    if received_at_ms.saturating_sub(sample.observed_at_ms) > EXPIRY_MS {
        return Outcome::Ignored("expired");
    }
    if let Some(last) = last {
        if last.session_id.as_deref() == Some(sample.session_id.as_str())
            && last.seq.is_some_and(|seq| sample.seq <= seq)
        {
            return Outcome::Ignored("duplicate");
        }
        if sample.observed_at_ms <= last.observed_at_ms {
            return Outcome::Ignored("out_of_order");
        }
    }
    Outcome::Stored {
        fresh: received_at_ms.saturating_sub(sample.observed_at_ms) <= REMOTE_STALE_MS,
    }
}

/// Request body of `POST /v1/devices/{device_id}/samples`, schema version 1
/// (docs/devices-ingest.md, "Sample fields"). The handler validates the raw JSON
/// itself with the contract's error codes; this type documents the shape, and a
/// test proves the contract examples fit it. Unknown fields are ignored, and the
/// server-owned fields `health`, `gpus`, `generated_at_ms`, `warnings`,
/// `maintenance.services` and `maintenance.ups` are rejected.
#[derive(Debug, Serialize, serde::Deserialize, ToSchema)]
pub struct DeviceSampleV1 {
    /// Only `1` is accepted.
    #[schema(minimum = 1, maximum = 1, example = 1)]
    pub schema_version: i64,
    /// Must equal the path id and the credential's device.
    #[schema(pattern = "^[a-z0-9][a-z0-9-]{0,62}$")]
    pub device_id: String,
    pub agent: SampleAgent,
    /// Random UUID v4 per agent process start.
    #[schema(format = "uuid")]
    pub session_id: String,
    /// Per-session counter, 1 to 2^53 − 1.
    #[schema(minimum = 1, maximum = 9007199254740991_i64)]
    pub seq: i64,
    /// Device wall clock (Unix ms) when the fast sample was taken.
    pub observed_at_ms: i64,
    /// Device wall clock (Unix ms) when this attempt was sent.
    pub sent_at_ms: i64,
    pub identity: HostIdentity,
    pub cpu: Cpu,
    pub memory: Ram,
    /// At most 32.
    pub filesystems: Vec<Filesystem>,
    /// At most 16.
    pub drives: Vec<Drive>,
    pub disk_io: DiskIo,
    pub network: Network,
    pub cooling: Cooling,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub power: Option<Power>,
    pub maintenance: SampleMaintenance,
    pub collector: CollectorHealth,
}

#[derive(Debug, Serialize, serde::Deserialize, ToSchema)]
pub struct SampleAgent {
    /// `factory-devices-agent`, at most 64 bytes.
    pub name: String,
    /// Agent semver, at most 64 bytes.
    pub version: String,
}

/// Only the device-reported parts of maintenance; services and UPS are server-owned.
#[derive(Debug, Serialize, serde::Deserialize, ToSchema)]
pub struct SampleMaintenance {
    pub backup: BackupView,
    pub clock: ClockView,
    pub reboot: RebootView,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct IngestResult {
    /// `stored` or `ignored`.
    pub result: String,
    pub device_id: String,
    pub session_id: String,
    pub seq: i64,
    pub observed_at_ms: i64,
    pub received_at_ms: i64,
    pub current_updated: bool,
    pub history_written: bool,
    /// Null on stored, except `clock_unsynchronized`; `duplicate`, `out_of_order` or `expired` on ignored.
    pub reason: Option<String>,
}

/// Per-device state kept in memory. It is lost on restart by design.
#[derive(Debug, Default)]
pub struct Remote {
    loaded: bool,
    last: Option<Last>,
    current: Option<DeviceView>,
    received_at_ms: Option<i64>,
    agent_version: Option<String>,
    clock_skew_ms: Option<i64>,
    dropped: i64,
    sessions: BTreeMap<String, (Option<String>, i64)>,
    changes: VecDeque<i64>,
    conflict_until: i64,
    conflict_hosts: Option<(String, String)>,
}

impl Remote {
    fn ingest_view(&self) -> IngestView {
        IngestView {
            source: "remote".into(),
            last_received_at_ms: self.received_at_ms,
            session_id: self.last.as_ref().and_then(|l| l.session_id.clone()),
            seq: self.last.as_ref().and_then(|l| l.seq),
            agent_version: self.agent_version.clone(),
            clock_skew_ms: self.clock_skew_ms,
            dropped_samples: self.dropped,
            identity_conflict: self.conflict_hosts.is_some(),
        }
    }

    /// Identity collision: more than two session changes in 5 minutes, or a
    /// session coming back after another one. Accepting continues either way.
    fn track_session(&mut self, sample: &Sample, now: i64) {
        let hostname = sample.host.identity.hostname.clone();
        self.sessions
            .retain(|_, (_, seen)| now - *seen <= CONFLICT_WINDOW_MS);
        self.changes.retain(|at| now - *at <= CONFLICT_WINDOW_MS);
        let previous = self.last.as_ref().and_then(|l| l.session_id.clone());
        if let Some(previous) = previous.filter(|p| *p != sample.session_id) {
            self.changes.push_back(now);
            let returning = self.sessions.contains_key(&sample.session_id);
            if returning || self.changes.len() > 2 {
                let other = self
                    .sessions
                    .get(&previous)
                    .and_then(|(host, _)| host.clone())
                    .unwrap_or_else(|| "unknown host".into());
                let this = hostname.clone().unwrap_or_else(|| "unknown host".into());
                self.conflict_until = now + CONFLICT_WINDOW_MS;
                self.conflict_hosts = Some((other, this));
            }
        }
        if now >= self.conflict_until {
            self.conflict_hosts = None;
        }
        self.sessions
            .insert(sample.session_id.clone(), (hostname, now));
    }
}

/// Remote-device registry: enrolled credentials, ingest state and rate limits.
pub struct Registry {
    pub tokens: crate::device_auth::Tokens,
    /// One ingest at a time, so ordering checks and commits never interleave.
    ingest: tokio::sync::Mutex<()>,
    devices: tokio::sync::RwLock<BTreeMap<String, Remote>>,
    rate: std::sync::Mutex<HashMap<String, (f64, i64)>>,
}

impl Registry {
    pub fn new(tokens: crate::device_auth::Tokens) -> Self {
        Self {
            tokens,
            ingest: Default::default(),
            devices: Default::default(),
            rate: Default::default(),
        }
    }

    /// Token bucket: 4 per second, burst 8. Err is the Retry-After in seconds.
    pub fn admit(&self, device_id: &str, now: i64) -> Result<(), u64> {
        let mut rate = self.rate.lock().expect("ingest rate lock");
        let (tokens, at) = rate.entry(device_id.into()).or_insert((RATE_BURST, now));
        let elapsed = (now - *at).max(0) as f64 / 1000.0;
        *tokens = (*tokens + elapsed * RATE_PER_S).min(RATE_BURST);
        *at = now;
        if *tokens >= 1.0 {
            *tokens -= 1.0;
            Ok(())
        } else {
            Err(((1.0 - *tokens) / RATE_PER_S).ceil().max(1.0) as u64)
        }
    }

    /// The device's view now: stale after 45 s of transport or collection age,
    /// and unknown until its first fresh sample since factory-api started.
    pub async fn view(&self, device_id: &str, now: i64) -> DeviceView {
        let devices = self.devices.read().await;
        let remote = devices.get(device_id);
        let ingest = remote
            .map(Remote::ingest_view)
            .unwrap_or_else(|| Remote::default().ingest_view());
        match remote.and_then(|r| r.current.as_ref()) {
            Some(current) => {
                let mut view = current.clone();
                view.ingest = Some(ingest);
                devices::freshen_within(
                    &view,
                    now,
                    REMOTE_STALE_MS,
                    remote.and_then(|r| r.received_at_ms),
                )
            }
            None => unknown(device_id, now, ingest),
        }
    }
}

fn unknown(device_id: &str, now: i64, ingest: IngestView) -> DeviceView {
    let mut view = devices::unavailable(now);
    view.device.device_id = device_id.into();
    view.device.maintenance.ups = remote_ups(now);
    view.warnings = vec![WAITING.into()];
    view.device.collector.detail = Some(WAITING.into());
    view.ingest = Some(ingest);
    view
}

fn warnings(remote: &Remote, host: &HostSnapshot) -> Vec<String> {
    let mut warnings = Vec::new();
    if let Some((a, b)) = &remote.conflict_hosts {
        warnings.push(format!(
            "identity conflict: sessions from {a} and {b} share this credential; revoke and reissue it"
        ));
    }
    if !host.collector.fast_ok {
        warnings.push("collector: fast sample failed".into());
    }
    if host.maintenance.reboot.availability == Availability::PermissionDenied {
        warnings.push("reboot: status is not readable".into());
    }
    warnings
}

impl crate::AppState {
    pub fn known_device(&self, id: &str) -> bool {
        id == devices::DEVICE_ID || self.remote.tokens.devices().iter().any(|d| d == id)
    }

    pub(crate) async fn remote_alert_inputs(
        &self,
        now: i64,
    ) -> Vec<(String, devices::DeviceAlertInput)> {
        let devices = self.remote.devices.read().await;
        self.remote
            .tokens
            .devices()
            .into_iter()
            .map(|id| {
                let input = match devices.get(&id).and_then(|r| r.current.as_ref()) {
                    Some(view) => view.alert_input(now),
                    None => unknown(&id, now, Remote::default().ingest_view()).alert_input(now),
                };
                (id, input)
            })
            .collect()
    }

    pub async fn remote_views(&self, now: i64) -> Vec<DeviceView> {
        let mut views = Vec::new();
        for id in self.remote.tokens.devices() {
            views.push(self.remote.view(&id, now).await);
        }
        views
    }

    /// Ingest rules 2–7 for a validated sample. Storage failure changes nothing.
    pub async fn ingest_sample(
        &self,
        sample: Sample,
        received_at_ms: i64,
    ) -> anyhow::Result<IngestResult> {
        let _serial = self.remote.ingest.lock().await;
        let id = sample.device_id.clone();
        let known = {
            let devices = self.remote.devices.read().await;
            devices
                .get(&id)
                .filter(|r| r.loaded)
                .map(|r| r.last.clone())
        };
        let last = match known {
            Some(last) => last,
            None => {
                let lookup = id.clone();
                let ts = self
                    .db
                    .requests
                    .read(&self.query_scope, move |db| {
                        crate::devices_history::latest_ts(db, &lookup)
                    })
                    .await?;
                let last = ts.map(|observed_at_ms| Last {
                    observed_at_ms,
                    session_id: None,
                    seq: None,
                });
                let mut devices = self.remote.devices.write().await;
                let remote = devices.entry(id.clone()).or_default();
                remote.loaded = true;
                remote.last = last.clone();
                last
            }
        };
        let result =
            |stored: bool, current: bool, history: bool, reason: Option<&str>| IngestResult {
                result: if stored { "stored" } else { "ignored" }.into(),
                device_id: id.clone(),
                session_id: sample.session_id.clone(),
                seq: sample.seq,
                observed_at_ms: sample.observed_at_ms,
                received_at_ms,
                current_updated: current,
                history_written: history,
                reason: reason.map(str::to_string),
            };
        let fresh = match decide(last.as_ref(), &sample, received_at_ms) {
            Outcome::Ignored(reason) => return Ok(result(false, false, false, Some(reason))),
            Outcome::Stored { fresh } => fresh,
        };
        let services = self
            .fleet
            .read()
            .await
            .nodes
            .iter()
            .find(|node| node.name == id)
            .map(|node| node.services.clone())
            .unwrap_or_default();
        let mut host = sample.host.clone();
        host.maintenance.services = services;
        host.health = devices::assess_within(&host, received_at_ms, REMOTE_STALE_MS);
        let synchronized = self.require_clock().is_ok() && sample.clock_synchronized();
        let history_written = if synchronized {
            let stored = crate::devices_history::StoredSample::from_host(&host);
            self.db
                .write(&self.query_scope, move |db| {
                    crate::devices_history::record(db, &stored)
                })
                .await?
        } else {
            false
        };
        let view = {
            let mut devices = self.remote.devices.write().await;
            let remote = devices.entry(id.clone()).or_default();
            remote.track_session(&sample, received_at_ms);
            if let Some(last) = &remote.last
                && last.session_id.as_deref() == Some(sample.session_id.as_str())
                && let Some(seq) = last.seq
            {
                remote.dropped += (sample.seq - seq - 1).max(0);
            }
            remote.last = Some(Last {
                observed_at_ms: sample.observed_at_ms,
                session_id: Some(sample.session_id.clone()),
                seq: Some(sample.seq),
            });
            remote.received_at_ms = Some(received_at_ms);
            remote.agent_version = Some(sample.agent_version.clone());
            remote.clock_skew_ms = Some(sample.sent_at_ms - received_at_ms);
            fresh.then(|| {
                let view = DeviceView {
                    generated_at_ms: received_at_ms,
                    warnings: warnings(remote, &host),
                    device: host,
                    maintenance: None,
                    ingest: Some(remote.ingest_view()),
                };
                remote.current = Some(view.clone());
                view
            })
        };
        if let Some(view) = &view {
            self.emit("devices.sample", view);
        }
        Ok(result(
            true,
            view.is_some(),
            history_written,
            (!synchronized).then_some("clock_unsynchronized"),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub const COMPLETE: &str = include_str!("../tests/fixtures/devices-ingest/complete.json");
    pub const PARTIAL: &str = include_str!("../tests/fixtures/devices-ingest/partial.json");
    pub const UNSUPPORTED: &str = include_str!("../tests/fixtures/devices-ingest/unsupported.json");
    const AT: i64 = 1_792_238_415_180;

    fn edit(fixture: &str, change: impl FnOnce(&mut Value)) -> Vec<u8> {
        let mut value: Value = serde_json::from_str(fixture).unwrap();
        change(&mut value);
        serde_json::to_vec(&value).unwrap()
    }

    fn rejected(body: &[u8]) -> (&'static str, Option<String>) {
        let error = parse(body, "factory-console", AT).unwrap_err();
        (error.code, error.field)
    }

    #[test]
    fn optional_power_is_validated_and_preserved() {
        assert!(
            parse(
                &edit(COMPLETE, |v| {
                    v.as_object_mut().unwrap().remove("power");
                }),
                "factory-console",
                AT
            )
            .unwrap()
            .host
            .power
            .is_none()
        );
        assert!(
            parse(
                &edit(COMPLETE, |v| v["power"] = Value::Null),
                "factory-console",
                AT
            )
            .unwrap()
            .host
            .power
            .is_none()
        );
        let body = edit(COMPLETE, |v| {
            v["power"] = serde_json::json!({
                "availability": "available", "observed_at_ms": v["observed_at_ms"],
                "adapter_online": true, "battery_status": "Discharging",
                "battery_percent": 25, "battery_power_w": 26.6, "detail": null
            });
        });
        let sample = parse(&body, "factory-console", AT).unwrap();
        let power = sample.host.power.as_ref().unwrap();
        assert_eq!(power.adapter_online, Some(true));
        assert_eq!(power.battery_status.as_deref(), Some("Discharging"));
        assert_eq!(power.battery_percent, Some(25.0));
        assert_eq!(power.battery_power_w, Some(26.6));
        let original: Value = serde_json::from_slice(&body).unwrap();
        for (key, bad_value) in [
            ("battery_percent", serde_json::json!(-1)),
            ("battery_percent", serde_json::json!(101)),
            ("battery_percent", serde_json::json!("25")),
            ("battery_power_w", serde_json::json!(-2)),
            ("battery_power_w", serde_json::json!(1001)),
            ("adapter_online", serde_json::json!(1)),
            ("battery_status", serde_json::json!("x".repeat(65))),
            ("detail", serde_json::json!("x".repeat(257))),
            ("observed_at_ms", serde_json::json!(AT + 1)),
            ("availability", serde_json::json!("unsupported")),
        ] {
            let mut invalid = original.clone();
            invalid["power"][key] = bad_value;
            assert!(
                parse(
                    &serde_json::to_vec(&invalid).unwrap(),
                    "factory-console",
                    AT
                )
                .is_err(),
                "{key}"
            );
        }
        let at = sample.observed_at_ms;
        let mut view = DeviceView {
            generated_at_ms: at,
            warnings: vec![],
            device: sample.host,
            maintenance: None,
            ingest: Some(
                Remote {
                    received_at_ms: Some(at),
                    ..Default::default()
                }
                .ingest_view(),
            ),
        };
        assert!(view.alert_input(at).power.is_some());
        assert!(view.alert_input(at + REMOTE_STALE_MS + 1).power.is_none());
        let stale =
            devices::freshen_within(&view, at + REMOTE_STALE_MS + 1, REMOTE_STALE_MS, Some(at));
        let power = stale.device.power.unwrap();
        assert_eq!(power.availability, Availability::Stale);
        assert_eq!(power.battery_percent, None);
        // Current envelopes must not make cached readings current again.
        view.device.observed_at_ms = at + 60_000;
        view.device.collector.last_fast_ms = Some(at + 60_000);
        view.ingest.as_mut().unwrap().last_received_at_ms = Some(at + 60_000);
        assert!(view.alert_input(at + 60_000).power.is_none());
    }

    #[test]
    fn contract_examples_parse() {
        let complete = parse(COMPLETE.as_bytes(), "factory-console", AT).unwrap();
        assert_eq!(complete.seq, 42);
        assert_eq!(complete.host.cpu.utilization.value, Some(12.5));
        assert!(complete.host.gpus.is_empty());
        assert_eq!(
            complete.host.maintenance.ups.availability,
            Availability::Unsupported
        );
        assert!(complete.clock_synchronized());
        let partial = parse(PARTIAL.as_bytes(), "factory-console", AT).unwrap();
        assert_eq!(
            partial.host.cpu.utilization.availability,
            Availability::Stale
        );
        assert_eq!(
            partial.host.maintenance.reboot.availability,
            Availability::PermissionDenied
        );
        let unsupported = parse(UNSUPPORTED.as_bytes(), "factory-console", AT + 15_000).unwrap();
        assert_eq!(
            unsupported.host.drives[0].smart.availability,
            Availability::Unsupported
        );
        assert!(unsupported.host.cooling.fans.is_empty());
        let mut host = unsupported.host.clone();
        host.health = devices::assess_within(&host, AT + 15_000, REMOTE_STALE_MS);
        // Unsupported SMART and fans do not fail the host, and are not "healthy" evidence.
        assert_eq!(host.health.status, HealthStatus::Healthy);
        assert!(
            devices::freshen_within(
                &DeviceView {
                    generated_at_ms: AT,
                    warnings: vec![],
                    device: host,
                    maintenance: None,
                    ingest: None,
                },
                AT + 15_000 + REMOTE_STALE_MS + 1,
                REMOTE_STALE_MS,
                Some(AT + 15_000),
            )
            .device
            .health
            .reasons
            .iter()
            .any(|r| r.metric == "ingest.transport")
        );
    }

    #[test]
    fn unknown_fields_are_ignored_at_every_level() {
        let body = edit(COMPLETE, |v| {
            v["future"] = Value::Bool(true);
            v["cpu"]["extra"] = Value::from(1);
            v["cpu"]["utilization"]["confidence"] = Value::from("high");
            v["drives"][0]["unsafe_shutdowns"] = Value::from(9);
        });
        let sample = parse(&body, "factory-console", AT).unwrap();
        assert_eq!(sample.host.drives[0].unsafe_shutdowns, None);
    }

    #[test]
    fn malformed_and_nonfinite_bodies_are_invalid_json() {
        for body in [
            &b"{"[..],
            &b"not json"[..],
            &br#"{"schema_version":1,"x":NaN}"#[..],
            &br#"{"schema_version":1,"x":Infinity}"#[..],
            &br#"{"schema_version":1,"x":1e400}"#[..],
        ] {
            assert_eq!(
                rejected(body).0,
                "invalid_json",
                "{}",
                String::from_utf8_lossy(body)
            );
        }
    }

    #[test]
    fn schema_version_is_checked_first() {
        assert_eq!(
            rejected(&edit(COMPLETE, |v| v["schema_version"] = 2.into())).0,
            "unsupported_schema_version"
        );
        assert_eq!(
            rejected(&edit(COMPLETE, |v| {
                v.as_object_mut().unwrap().remove("schema_version");
            }))
            .0,
            "unsupported_schema_version"
        );
        assert_eq!(
            rejected(&edit(COMPLETE, |v| v["schema_version"] = "1".into())).0,
            "unsupported_schema_version"
        );
        assert_eq!(rejected(b"[1]").0, "unsupported_schema_version");
        // Version wins over every other problem.
        assert_eq!(
            rejected(br#"{"schema_version":2,"health":1}"#).0,
            "unsupported_schema_version"
        );
        let error = parse(
            &edit(COMPLETE, |v| v["schema_version"] = 2.into()),
            "factory-console",
            AT,
        )
        .unwrap_err();
        assert_eq!(error.message, "schema_version 2 is not accepted");
    }

    #[test]
    fn server_owned_fields_are_rejected() {
        for key in ["health", "gpus", "generated_at_ms", "warnings"] {
            assert_eq!(
                rejected(&edit(COMPLETE, |v| v[key] = Value::Null)),
                ("server_owned_field", Some(key.into()))
            );
        }
        for key in ["services", "ups"] {
            assert_eq!(
                rejected(&edit(COMPLETE, |v| v["maintenance"][key] = Value::Array(vec![]))),
                ("server_owned_field", Some(format!("maintenance.{key}")))
            );
        }
    }

    #[test]
    fn contract_examples_fit_the_documented_request_schema() {
        // Round-tripping through DeviceSampleV1 loses no field, so the OpenAPI body
        // schema can represent every contract example.
        // Numbers compare by value: 1800 in the example comes back as 1800.0.
        fn numeric(value: Value) -> Value {
            match value {
                Value::Number(n) => serde_json::json!(n.as_f64().unwrap()),
                Value::Array(items) => items.into_iter().map(numeric).collect(),
                Value::Object(map) => map.into_iter().map(|(k, v)| (k, numeric(v))).collect(),
                other => other,
            }
        }
        for fixture in [COMPLETE, PARTIAL, UNSUPPORTED] {
            let original: Value = serde_json::from_str(fixture).unwrap();
            let typed: DeviceSampleV1 = serde_json::from_value(original.clone()).unwrap();
            assert_eq!(
                numeric(serde_json::to_value(&typed).unwrap()),
                numeric(original)
            );
        }
    }

    #[test]
    fn backup_fields_are_null_unless_available() {
        // The partial example reports backup availability `error` with every field null.
        for key in ["error", "last_success_ms", "last_attempt_ms"] {
            let value: Value = if key == "error" {
                "status file unreadable".into()
            } else {
                AT.into()
            };
            assert_eq!(
                rejected(&edit(PARTIAL, |v| v["maintenance"]["backup"][key] = value.clone())),
                ("invalid_metric", Some(format!("maintenance.backup.{key}"))),
            );
        }
        let failed = edit(COMPLETE, |v| {
            v["maintenance"]["backup"]["error"] = "last run exited 1".into()
        });
        let sample = parse(&failed, "factory-console", AT).unwrap();
        assert_eq!(
            sample.host.maintenance.backup.error.as_deref(),
            Some("last run exited 1")
        );
    }

    #[test]
    fn field_errors_name_the_field() {
        type Change = Box<dyn Fn(&mut Value)>;
        let cases: Vec<(Change, &str, &str)> = vec![
            (
                Box::new(|v| {
                    v.as_object_mut().unwrap().remove("cpu");
                }),
                "missing_field",
                "cpu",
            ),
            (
                Box::new(|v| {
                    v["memory"].as_object_mut().unwrap().remove("used");
                }),
                "missing_field",
                "memory.used",
            ),
            (
                Box::new(|v| {
                    v["cpu"]["load1"].as_object_mut().unwrap().remove("detail");
                }),
                "missing_field",
                "cpu.load1.detail",
            ),
            (Box::new(|v| v["seq"] = 0.into()), "invalid_field", "seq"),
            (Box::new(|v| v["seq"] = 1.5.into()), "invalid_field", "seq"),
            (
                Box::new(|v| v["seq"] = (1_i64 << 53).into()),
                "invalid_field",
                "seq",
            ),
            (
                Box::new(|v| v["session_id"] = "not-a-uuid".into()),
                "invalid_field",
                "session_id",
            ),
            (
                Box::new(|v| v["device_id"] = "Factory_Console".into()),
                "invalid_field",
                "device_id",
            ),
            (
                Box::new(|v| v["agent"]["version"] = "x".repeat(65).into()),
                "invalid_field",
                "agent.version",
            ),
            (
                Box::new(|v| v["filesystems"][0]["mountpoint"] = "m".repeat(257).into()),
                "invalid_field",
                "filesystems[0].mountpoint",
            ),
            (
                Box::new(|v| v["cpu"]["load1"]["detail"] = "d".repeat(257).into()),
                "invalid_field",
                "cpu.load1.detail",
            ),
            (
                Box::new(|v| v["cpu"]["utilization"]["value"] = 140.into()),
                "invalid_metric",
                "cpu.utilization",
            ),
            (
                Box::new(|v| v["cpu"]["utilization"]["unit"] = "ratio".into()),
                "invalid_metric",
                "cpu.utilization",
            ),
            (
                Box::new(|v| v["cpu"]["utilization"]["value"] = Value::Null),
                "invalid_metric",
                "cpu.utilization",
            ),
            (
                Box::new(|v| v["cpu"]["utilization"]["value"] = "12".into()),
                "invalid_metric",
                "cpu.utilization",
            ),
            (
                Box::new(|v| {
                    v["cpu"]["utilization"]["availability"] = "stale".into();
                }),
                "invalid_metric",
                "cpu.utilization",
            ),
            (
                Box::new(|v| v["cpu"]["utilization"]["availability"] = "unknown".into()),
                "invalid_metric",
                "cpu.utilization.availability",
            ),
            (
                Box::new(|v| v["cpu"]["temperature"]["value"] = (-41).into()),
                "invalid_metric",
                "cpu.temperature",
            ),
            (
                Box::new(|v| v["memory"]["total"]["value"] = 1.5.into()),
                "invalid_metric",
                "memory.total",
            ),
            (
                Box::new(|v| v["network"]["rx"]["value"] = 1e13.into()),
                "invalid_metric",
                "network.rx",
            ),
            (
                Box::new(|v| v["cooling"]["fans"][0]["metric"]["value"] = 30_001.into()),
                "invalid_metric",
                "cooling.fans[0].metric",
            ),
            (
                Box::new(|v| v["cpu"]["load1"]["observed_at_ms"] = 1_792_238_415_001_i64.into()),
                "invalid_metric",
                "cpu.load1.observed_at_ms",
            ),
            (
                Box::new(|v| v["drives"][0]["smart"]["availability"] = "unsupported".into()),
                "invalid_metric",
                "drives[0].smart.passed",
            ),
            (
                Box::new(|v| v["maintenance"]["clock"]["availability"] = "error".into()),
                "invalid_metric",
                "maintenance.clock.synchronized",
            ),
            (
                Box::new(|v| v["drives"][0]["spare_threshold_percent"] = 101.into()),
                "invalid_metric",
                "drives[0].spare_threshold_percent",
            ),
            (
                Box::new(|v| {
                    let fs = v["filesystems"][0].clone();
                    v["filesystems"].as_array_mut().unwrap().push(fs);
                }),
                "invalid_field",
                "filesystems[1].id",
            ),
            (
                Box::new(|v| {
                    let t = v["cooling"]["temperatures"][0].clone();
                    v["cooling"]["temperatures"].as_array_mut().unwrap().push(t);
                }),
                "invalid_field",
                "cooling.temperatures[1].name",
            ),
            (
                Box::new(|v| v["device_id"] = "factory-other".into()),
                "device_mismatch",
                "device_id",
            ),
        ];
        for (change, code, field) in cases {
            assert_eq!(
                rejected(&edit(COMPLETE, change)),
                (code, Some(field.into())),
                "{field}"
            );
        }
    }

    #[test]
    fn item_caps_are_too_many_items() {
        let many = |key: &'static str, count: usize| {
            edit(COMPLETE, move |v| {
                let pointer: Vec<&str> = key.split('.').collect();
                let mut target = &mut *v;
                for part in &pointer {
                    target = &mut target[*part];
                }
                let first = target[0].clone();
                *target = Value::Array(
                    (0..count)
                        .map(|i| {
                            let mut item = first.clone();
                            if item.get("id").is_some() {
                                item["id"] = format!("id-{i}").into();
                            } else {
                                item["name"] = format!("sensor-{i}").into();
                            }
                            item
                        })
                        .collect(),
                );
            })
        };
        for (key, limit) in [
            ("filesystems", 32),
            ("drives", 16),
            ("cooling.temperatures", 64),
            ("cooling.fans", 16),
        ] {
            assert!(
                parse(&many(key, limit), "factory-console", AT).is_ok(),
                "{key} at limit"
            );
            assert_eq!(
                rejected(&many(key, limit + 1)),
                ("too_many_items", Some(key.into()))
            );
        }
    }

    #[test]
    fn future_skew_beyond_sixty_seconds_is_rejected() {
        let ahead = |observed: i64, sent: i64| {
            edit(COMPLETE, move |v| {
                v["observed_at_ms"] = observed.into();
                v["sent_at_ms"] = sent.into();
            })
        };
        let base = 1_792_238_415_000_i64;
        assert!(parse(&ahead(base, base), "factory-console", base - 60_000).is_ok());
        assert_eq!(
            parse(&ahead(base, base), "factory-console", base - 60_001)
                .unwrap_err()
                .code,
            "clock_skew"
        );
        assert_eq!(
            parse(&ahead(base, base + 1_000), "factory-console", base - 59_500)
                .unwrap_err()
                .field
                .as_deref(),
            Some("sent_at_ms")
        );
    }

    fn sample(session: &str, seq: i64, observed: i64) -> Sample {
        let mut s = parse(COMPLETE.as_bytes(), "factory-console", AT).unwrap();
        s.session_id = session.into();
        s.seq = seq;
        s.observed_at_ms = observed;
        s
    }

    #[test]
    fn ordering_rules() {
        let a = "6f1c2a9e-3b4d-4e8f-9a01-2c3d4e5f6a7b";
        let b = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
        let now = 10 * EXPIRY_MS;
        let last = Last {
            observed_at_ms: now - 1_000,
            session_id: Some(a.into()),
            seq: Some(5),
        };
        assert_eq!(
            decide(None, &sample(a, 1, now - 100), now),
            Outcome::Stored { fresh: true }
        );
        assert_eq!(
            decide(Some(&last), &sample(a, 5, now - 1_000), now),
            Outcome::Ignored("duplicate")
        );
        // An earlier seq of the same session is a duplicate even when its time is newer.
        assert_eq!(
            decide(Some(&last), &sample(a, 4, now), now),
            Outcome::Ignored("duplicate")
        );
        assert_eq!(
            decide(Some(&last), &sample(a, 6, now - 1_000), now),
            Outcome::Ignored("out_of_order")
        );
        // A restarted agent (new session, seq 1) is accepted by time, not seq.
        assert_eq!(
            decide(Some(&last), &sample(b, 1, now - 500), now),
            Outcome::Stored { fresh: true }
        );
        assert_eq!(
            decide(Some(&last), &sample(b, 1, now - 2_000), now),
            Outcome::Ignored("out_of_order")
        );
        // After a server restart only the time is known: a retry is out_of_order.
        let reloaded = Last {
            observed_at_ms: now - 1_000,
            session_id: None,
            seq: None,
        };
        assert_eq!(
            decide(Some(&reloaded), &sample(a, 5, now - 1_000), now),
            Outcome::Ignored("out_of_order")
        );
        // Backlog older than 45 s writes history only; older than 2 h expires.
        assert_eq!(
            decide(None, &sample(a, 1, now - REMOTE_STALE_MS), now),
            Outcome::Stored { fresh: true }
        );
        assert_eq!(
            decide(None, &sample(a, 1, now - REMOTE_STALE_MS - 1), now),
            Outcome::Stored { fresh: false }
        );
        assert_eq!(
            decide(None, &sample(a, 1, now - EXPIRY_MS), now),
            Outcome::Stored { fresh: false }
        );
        assert_eq!(
            decide(None, &sample(a, 1, now - EXPIRY_MS - 1), now),
            Outcome::Ignored("expired")
        );
        assert_eq!(
            decide(Some(&last), &sample(a, 2, now - EXPIRY_MS - 1), now),
            Outcome::Ignored("expired")
        );
    }

    #[test]
    fn rate_limit_is_four_per_second_with_burst_eight() {
        let registry = Registry::new(crate::device_auth::Tokens::new("/nonexistent"));
        for _ in 0..8 {
            assert!(registry.admit("a", 0).is_ok());
        }
        assert_eq!(registry.admit("a", 0), Err(1));
        // Other devices have their own bucket.
        assert!(registry.admit("b", 0).is_ok());
        assert!(registry.admit("a", 250).is_ok());
        assert!(registry.admit("a", 250).is_err());
        assert!(registry.admit("a", 1_250).is_ok());
    }

    #[test]
    fn identity_conflict_after_alternating_sessions() {
        let mut remote = Remote::default();
        let mut feed = |session: &str, host: &str, at: i64| {
            let mut s = sample(session, 1, at);
            s.host.identity.hostname = Some(host.into());
            remote.track_session(&s, at);
            remote.last = Some(Last {
                observed_at_ms: at,
                session_id: Some(s.session_id),
                seq: Some(1),
            });
            remote.conflict_hosts.clone()
        };
        assert_eq!(feed("a", "console", 0), None);
        assert_eq!(feed("a", "console", 15_000), None);
        // An agent restart is one change, not a conflict.
        assert_eq!(feed("b", "console", 30_000), None);
        assert!(feed("c", "imposter", 45_000).is_none());
        assert_eq!(
            feed("b", "console", 60_000),
            Some(("imposter".into(), "console".into()))
        );
        // Clears once the window passes without another collision.
        assert!(feed("b", "console", 60_000 + CONFLICT_WINDOW_MS).is_none());
    }
}
