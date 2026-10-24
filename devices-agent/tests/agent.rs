//! Agent tests with fixture roots and a fake factory-api. No host probes, no
//! privileged actions, no network beyond loopback.
use axum::{
    Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use factory_api::devices::Availability;
use factory_api::devices_ingest::{self, DeviceSampleV1, Last, Outcome};
use factory_devices_agent::*;
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

const TOKEN: &str = "fdv1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

fn write(root: &Path, rel: &str, body: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
}

/// A console-like host: one NVMe disk, coretemp, a PrivateTmp bind, and no
/// published backup or reboot status.
fn console(root: &Path) {
    write(root, "proc/stat", "cpu  100 0 100 800 0 0 0 0 0 0\n");
    write(
        root,
        "proc/meminfo",
        "MemTotal: 1000000 kB\nMemAvailable: 250000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n",
    );
    write(root, "proc/uptime", "1000.0 800.0\n");
    write(root, "proc/loadavg", "0.1 0.2 0.3 1/10 1\n");
    write(
        root,
        "proc/diskstats",
        " 259 0 nvme0n1 1 0 100 0 1 0 50 0 0 0 0 0\n",
    );
    write(
        root,
        "proc/net/dev",
        "  wlan0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\n",
    );
    write(root, "proc/sys/kernel/hostname", "factory-console\n");
    write(
        root,
        "proc/sys/kernel/random/boot_id",
        "0b7d6c1e-8f2a-4c3b-9d4e-5f6a7b8c9d0e\n",
    );
    write(
        root,
        "proc/self/mountinfo",
        "36 35 259:2 / / ro - ext4 /dev/nvme0n1p2 rw\n\
         40 36 259:2 /tmp/systemd-private-abc-factory-devices-agent.service-x/tmp /tmp rw - ext4 /dev/nvme0n1p2 rw\n",
    );
    write(
        root,
        "sys/fs/factory-mountstat",
        "/\t1000\t400\t100\t20\n/tmp\t1000\t400\t100\t20\n",
    );
    write(root, "sys/block/nvme0n1/size", "2048\n");
    write(
        root,
        "sys/block/nvme0n1/device/wwid",
        "eui.0025388b91b2c3d4\n",
    );
    write(root, "sys/class/hwmon/hwmon0/name", "coretemp\n");
    write(root, "sys/class/hwmon/hwmon0/temp1_input", "51000\n");
    write(root, "sys/class/hwmon/hwmon0/temp1_label", "Package id 0\n");
    write(
        root,
        "var/lib/factory-devices/smart.json",
        r#"{"observed_at_ms":1,"drives":[{"kernel":"nvme0n1","passed":true,"available_spare_percent":100,"spare_threshold_percent":2,"media_errors":0,"media_critical":false,"temperature_c":38}]}"#,
    );
}

fn synced() -> Option<bool> {
    Some(true)
}

fn collector(root: &Path, session: &str) -> Collector {
    Collector::new(
        Sources {
            root: root.to_path_buf(),
            clock: synced,
            probe_timeout: Duration::from_millis(500),
        },
        session.into(),
    )
}

fn json_of(sample: &DeviceSampleV1) -> Value {
    serde_json::to_value(sample).unwrap()
}

fn availability(value: &Value) -> &str {
    value["availability"].as_str().unwrap()
}

fn accepted(sample: &DeviceSampleV1) -> devices_ingest::Sample {
    assert_eq!(locally_valid(sample), Ok(()));
    devices_ingest::parse(
        &serde_json::to_vec(sample).unwrap(),
        DEVICE_ID,
        sample.observed_at_ms,
    )
    .expect("server accepts")
}

fn applesmc(root: &Path) {
    let node = root.join("sys/devices/platform/applesmc.768");
    let acpi = root.join("sys/bus/acpi/devices/APP0001:00");
    fs::create_dir_all(&node).unwrap();
    fs::create_dir_all(&acpi).unwrap();
    std::os::unix::fs::symlink(&node, acpi.join("physical_node")).unwrap();
}

#[test]
fn applesmc_symlink_fans_preserve_hwmon_and_refresh_on_slow_cadence() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    console(root);
    applesmc(root);
    let node = "sys/bus/acpi/devices/APP0001:00/physical_node";
    write(root, &format!("{node}/fan1_input"), "2200\n");
    write(root, &format!("{node}/fan2_input"), "2300\n");
    write(root, &format!("{node}/fan1_label"), "Left\n");
    write(root, &format!("{node}/fan1_min"), "1200\n");
    write(root, &format!("{node}/fan1_max"), "6000\n");
    write(root, "sys/class/hwmon/hwmon0/fan1_input", "1500\n");
    let mut agent = collector(root, &new_session_id().unwrap());
    let first = agent.sample(1_000_000);
    let fans = &first.cooling.fans;
    assert_eq!(first.cooling.fans_availability, Availability::Available);
    assert_eq!(fans.len(), 3);
    for (name, rpm) in [
        ("coretemp fan1", 1500.0),
        ("applesmc fan1", 2200.0),
        ("applesmc fan2", 2300.0),
    ] {
        let metric = &fans.iter().find(|fan| fan.name == name).unwrap().metric;
        assert_eq!(metric.value, Some(rpm));
        assert_eq!(metric.unit, "rpm");
        assert_eq!(metric.availability, Availability::Available);
    }
    assert!(fans.iter().all(|fan| fan.metric.detail.is_none()));
    assert_eq!(accepted(&first).host.cooling.fans, *fans);
    write(root, &format!("{node}/fan1_input"), "2400\n");
    write(root, "sys/class/hwmon/hwmon0/fan1_input", "1600\n");
    write(root, "sys/class/hwmon/hwmon0/temp1_input", "61000\n");
    let next = agent.sample(1_015_000);
    assert_eq!(next.cooling, first.cooling);
    assert_eq!(next.cpu.temperature, first.cpu.temperature);
    accepted(&next);
    let next = agent.sample(1_300_000);
    assert_eq!(next.cooling.fans.len(), 3);
    for (name, rpm) in [("applesmc fan1", 2400.0), ("coretemp fan1", 1600.0)] {
        let metric = &next
            .cooling
            .fans
            .iter()
            .find(|fan| fan.name == name)
            .unwrap()
            .metric;
        assert_eq!(metric.value, Some(rpm));
        assert_eq!(metric.observed_at_ms, 1_300_000);
    }
    assert_eq!(next.cpu.temperature.value, Some(61.0));
    assert_eq!(next.cpu.temperature.observed_at_ms, 1_300_000);
    accepted(&next);
}

#[test]
fn absent_applesmc_leaves_hwmon_fans_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    console(dir.path());
    let empty = collector(dir.path(), &new_session_id().unwrap()).sample(1_000_000);
    assert!(empty.cooling.fans.is_empty());
    assert_eq!(empty.cooling.fans_availability, Availability::Unsupported);
    write(dir.path(), "sys/class/hwmon/hwmon0/fan1_input", "1500\n");
    let sample = collector(dir.path(), &new_session_id().unwrap()).sample(1_000_000);
    assert_eq!(sample.cooling.fans.len(), 1);
    assert_eq!(sample.cooling.fans[0].name, "coretemp fan1");
    assert_eq!(sample.cooling.fans[0].metric.value, Some(1500.0));
    assert_eq!(sample.cooling.fans_availability, Availability::Available);
    accepted(&sample);
}

#[test]
fn applesmc_invalid_rpm_and_long_labels_stay_inside_contract() {
    let dir = tempfile::tempdir().unwrap();
    console(dir.path());
    applesmc(dir.path());
    let node = "sys/bus/acpi/devices/APP0001:00/physical_node";
    for (index, value) in ["NaN", "-1", "30001", "bad", "1200"].iter().enumerate() {
        write(dir.path(), &format!("{node}/fan{}_input", index + 1), value);
    }
    write(dir.path(), &format!("{node}/fan5_label"), &"é".repeat(300));
    let sample = collector(dir.path(), &new_session_id().unwrap()).sample(1_000_000);
    assert_eq!(sample.cooling.fans.len(), 5);
    for fan in &sample.cooling.fans[..4] {
        assert_eq!(fan.metric.availability, Availability::Error);
        assert_eq!(fan.metric.value, None);
    }
    assert_eq!(sample.cooling.fans[4].metric.value, Some(1200.0));
    assert_eq!(sample.cooling.fans[4].metric.detail, None);
    accepted(&sample);
}

fn battery(root: &Path) {
    write(root, "sys/class/power_supply/ADP/type", "Mains\n");
    write(root, "sys/class/power_supply/ADP/online", "1\n");
    write(root, "sys/class/power_supply/BAT0/type", "Battery\n");
    write(root, "sys/class/power_supply/BAT0/status", "Charging\n");
    write(root, "sys/class/power_supply/BAT0/capacity", "73\n");
}

#[test]
fn power_direct_and_fallback_watts_survive_ingest_and_refresh() {
    for direct in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        console(root);
        battery(root);
        write(root, "sys/class/power_supply/BAT0/current_now", "2000000\n");
        write(
            root,
            "sys/class/power_supply/BAT0/voltage_now",
            "12000000\n",
        );
        if direct {
            write(root, "sys/class/power_supply/BAT0/power_now", "-18500000\n");
        }
        let mut agent = collector(root, &new_session_id().unwrap());
        let sample = agent.sample(1_000_000);
        let power = sample.power.as_ref().unwrap();
        assert_eq!(power.availability, Availability::Available);
        assert_eq!(power.observed_at_ms, 1_000_000);
        assert_eq!(power.adapter_online, Some(true));
        assert_eq!(power.battery_status.as_deref(), Some("Charging"));
        assert_eq!(power.battery_percent, Some(73.0));
        assert_eq!(
            power.battery_power_w,
            Some(if direct { 18.5 } else { 24.0 })
        );
        assert_eq!(accepted(&sample).host.power, sample.power);
        write(root, "sys/class/power_supply/ADP/online", "0\n");
        write(root, "sys/class/power_supply/BAT0/status", "Discharging\n");
        write(root, "sys/class/power_supply/BAT0/capacity", "72\n");
        let next = agent.sample(1_015_000);
        let power = next.power.as_ref().unwrap();
        assert_eq!(power.observed_at_ms, 1_015_000);
        assert_eq!(power.adapter_online, Some(false));
        assert_eq!(power.battery_status.as_deref(), Some("Discharging"));
        assert_eq!(power.battery_percent, Some(72.0));
        assert_eq!(accepted(&next).host.power, next.power);
    }
}

#[test]
fn power_selects_first_sorted_battery_and_any_online_mains() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    console(root);
    // Created first, but sorted after BAT0; its readings must not win.
    write(root, "sys/class/power_supply/BAT1/type", "Battery\n");
    write(root, "sys/class/power_supply/BAT1/status", "Discharging\n");
    write(root, "sys/class/power_supply/BAT1/capacity", "5\n");
    battery(root);
    write(root, "sys/class/power_supply/ADP/online", "0\n");
    write(root, "sys/class/power_supply/AC/type", "Mains\n");
    write(root, "sys/class/power_supply/AC/online", "bad\n");
    write(root, "sys/class/power_supply/OTHER/type", "Mains\n");
    write(root, "sys/class/power_supply/OTHER/online", "1\n");
    let sample = collector(root, &new_session_id().unwrap()).sample(1_000_000);
    let power = sample.power.as_ref().unwrap();
    assert_eq!(power.adapter_online, Some(true));
    assert_eq!(power.battery_percent, Some(73.0));
    assert_eq!(power.battery_status.as_deref(), Some("Charging"));
    assert_eq!(power.battery_power_w, None);
    assert_eq!(power.availability, Availability::Available);
    accepted(&sample);
    for name in ["ADP", "AC", "OTHER"] {
        fs::remove_dir_all(root.join(format!("sys/class/power_supply/{name}"))).unwrap();
    }
    write(root, "sys/class/power_supply/BAT0/status", "Unknown\n");
    let sample = collector(root, &new_session_id().unwrap()).sample(1_000_000);
    let power = sample.power.as_ref().unwrap();
    assert_eq!(power.adapter_online, None);
    assert_eq!(power.battery_status.as_deref(), Some("Unknown"));
    accepted(&sample);
}

#[test]
fn power_without_battery_is_unsupported() {
    let dir = tempfile::tempdir().unwrap();
    console(dir.path());
    for mains in [false, true] {
        if mains {
            write(dir.path(), "sys/class/power_supply/ADP/type", "Mains\n");
            write(dir.path(), "sys/class/power_supply/ADP/online", "1\n");
        }
        let sample = collector(dir.path(), &new_session_id().unwrap()).sample(1_000_000);
        let power = sample.power.as_ref().unwrap();
        assert_eq!(power.availability, Availability::Unsupported);
        assert_eq!(power.adapter_online, None);
        assert_eq!(power.battery_status, None);
        assert_eq!(power.battery_percent, None);
        assert_eq!(power.battery_power_w, None);
        assert_eq!(accepted(&sample).host.power, sample.power);
    }
}

#[test]
fn power_missing_or_malformed_required_fields_cannot_recover() {
    for (field, value) in [
        ("status", None),
        ("status", Some("")),
        ("status", Some("garbage")),
        ("capacity", None),
        ("capacity", Some("NaN")),
        ("capacity", Some("inf")),
        ("capacity", Some("101")),
        ("capacity", Some("-1")),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        console(root);
        battery(root);
        let mut agent = collector(root, &new_session_id().unwrap());
        let before = agent.sample(1_000_000);
        assert_eq!(before.power.unwrap().availability, Availability::Available);
        let path = format!("sys/class/power_supply/BAT0/{field}");
        if let Some(value) = value {
            write(root, &path, value);
        } else {
            fs::remove_file(root.join(path)).unwrap();
        }
        let sample = agent.sample(1_015_000);
        let power = sample.power.as_ref().unwrap();
        assert_eq!(power.availability, Availability::Error, "{field}={value:?}");
        assert_eq!(power.battery_status, None);
        assert_eq!(power.battery_percent, None);
        assert_eq!(power.adapter_online, None);
        assert_eq!(power.battery_power_w, None);
        assert!(power.detail.is_some());
        assert_eq!(power.observed_at_ms, 1_015_000);
        accepted(&sample);
    }
}

#[test]
fn power_bad_optional_wattage_and_adapter_do_not_hide_battery() {
    for value in ["NaN", "inf", "1e300", "garbage"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        console(root);
        battery(root);
        write(root, "sys/class/power_supply/ADP/online", "bad\n");
        write(root, "sys/class/power_supply/BAT0/power_now", value);
        write(root, "sys/class/power_supply/BAT0/current_now", value);
        write(
            root,
            "sys/class/power_supply/BAT0/voltage_now",
            "12000000\n",
        );
        let sample = collector(root, &new_session_id().unwrap()).sample(1_000_000);
        let power = sample.power.as_ref().unwrap();
        assert_eq!(power.availability, Availability::Available);
        assert_eq!(power.battery_percent, Some(73.0));
        assert_eq!(power.battery_status.as_deref(), Some("Charging"));
        assert_eq!(power.battery_power_w, None, "{value}");
        assert_eq!(power.adapter_online, None);
        accepted(&sample);
    }
}

#[test]
fn power_conform_limits_fields_and_blanks_unavailable_readings() {
    let dir = tempfile::tempdir().unwrap();
    console(dir.path());
    let mut sample = collector(dir.path(), &new_session_id().unwrap()).sample(1_000_000);
    for (percent, watts, expected_percent, expected_watts) in [
        (0.0, 0.0, Some(0.0), Some(0.0)),
        (100.0, 1000.0, Some(100.0), Some(1000.0)),
        (-1.0, -1.0, None, None),
        (100.1, 1000.1, None, None),
        (f64::NAN, f64::NAN, None, None),
        (f64::INFINITY, f64::NEG_INFINITY, None, None),
    ] {
        sample.power = Some(factory_api::devices::Power {
            availability: Availability::Available,
            observed_at_ms: sample.observed_at_ms + 1,
            adapter_online: Some(true),
            battery_status: Some(format!("a{}", "é".repeat(40))),
            battery_percent: Some(percent),
            battery_power_w: Some(watts),
            detail: Some(format!("a{}", "é".repeat(140))),
        });
        conform(&mut sample);
        let power = sample.power.as_ref().unwrap();
        assert_eq!(power.battery_percent, expected_percent);
        assert_eq!(power.battery_power_w, expected_watts);
        assert_eq!(power.adapter_online, Some(true));
        assert_eq!(power.observed_at_ms, sample.observed_at_ms);
        assert_eq!(
            power.battery_status.as_deref(),
            Some(format!("a{}", "é".repeat(31)).as_str())
        );
        assert_eq!(
            power.detail.as_deref(),
            Some(format!("a{}", "é".repeat(127)).as_str())
        );
        assert_eq!(accepted(&sample).host.power, sample.power);
    }
    for availability in [
        Availability::Unsupported,
        Availability::PermissionDenied,
        Availability::Stale,
        Availability::Error,
    ] {
        sample.power = Some(factory_api::devices::Power {
            availability,
            observed_at_ms: sample.observed_at_ms,
            adapter_online: Some(true),
            battery_status: Some("Charging".into()),
            battery_percent: Some(73.0),
            battery_power_w: Some(24.0),
            detail: Some("unavailable source".into()),
        });
        conform(&mut sample);
        let power = sample.power.as_ref().unwrap();
        assert_eq!(power.availability, availability);
        assert_eq!(power.adapter_online, None);
        assert_eq!(power.battery_status, None);
        assert_eq!(power.battery_percent, None);
        assert_eq!(power.battery_power_w, None);
        assert_eq!(power.detail.as_deref(), Some("unavailable source"));
        assert_eq!(accepted(&sample).host.power, sample.power);
    }
}

#[test]
fn applesmc_and_power_reads_timeout_without_rejecting_sample() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    console(root);
    applesmc(root);
    battery(root);
    fs::remove_file(root.join("sys/class/power_supply/BAT0/status")).unwrap();
    for rel in [
        "sys/bus/acpi/devices/APP0001:00/physical_node/fan1_input",
        "sys/class/power_supply/BAT0/status",
    ] {
        let path = std::ffi::CString::new(root.join(rel).to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    }
    let sample = sample_within(root, Duration::from_secs(5));
    assert!(sample.cooling.fans.is_empty());
    assert_eq!(sample.cooling.fans_availability, Availability::Unsupported);
    assert_eq!(
        sample.power.as_ref().unwrap().availability,
        Availability::Error
    );
    assert_eq!(
        sample.power.as_ref().unwrap().detail.as_deref(),
        Some("timed out")
    );
    accepted(&sample);
}

#[test]
fn identity_rates_and_unpublished_status() {
    let dir = tempfile::tempdir().unwrap();
    console(dir.path());
    let session = new_session_id().unwrap();
    assert_eq!(session.len(), 36);
    assert_eq!(&session[14..15], "4", "UUID v4");
    let mut agent = collector(dir.path(), &session);
    let first = agent.sample(1_000_000);
    write(dir.path(), "proc/stat", "cpu  150 0 150 900 0 0 0 0 0 0\n");
    let second = agent.sample(1_015_000);
    let (a, b) = (json_of(&first), json_of(&second));
    assert_eq!(a["device_id"], "factory-console");
    assert_eq!(a["agent"]["name"], "factory-devices-agent");
    assert_eq!((a["seq"].as_i64(), b["seq"].as_i64()), (Some(1), Some(2)));
    assert_eq!(a["session_id"], b["session_id"]);
    assert_eq!(availability(&a["cpu"]["utilization"]), "stale");
    assert_eq!(
        a["cpu"]["utilization"]["detail"],
        "waiting for a second sample"
    );
    // 100 of 200 jiffies were busy.
    assert_eq!(b["cpu"]["utilization"]["value"], 50.0);
    assert_eq!(b["cpu"]["temperature"]["value"], 51.0);
    assert_eq!(b["identity"]["hostname"], "factory-console");
    // Not published on this node: unsupported, not an error.
    assert_eq!(availability(&b["maintenance"]["backup"]), "unsupported");
    assert_eq!(availability(&b["maintenance"]["reboot"]), "unsupported");
    assert_eq!(b["maintenance"]["clock"]["synchronized"], true);
    assert_eq!(b["drives"][0]["smart"]["passed"], true);
    // The unit's own PrivateTmp bind is not a host filesystem.
    let mounts: Vec<_> = b["filesystems"]
        .as_array()
        .unwrap()
        .iter()
        .map(|fs| fs["mountpoint"].as_str().unwrap())
        .collect();
    assert_eq!(mounts, ["/"]);
    for (sample, at) in [(&first, 1_000_000), (&second, 1_015_000)] {
        assert_eq!(locally_valid(sample), Ok(()));
        // The server's own parser accepts it.
        let body = serde_json::to_vec(sample).unwrap();
        devices_ingest::parse(&body, DEVICE_ID, at).expect("server accepts");
    }
}

#[test]
fn published_status_is_read_and_missing_root_is_still_valid() {
    let dir = tempfile::tempdir().unwrap();
    console(dir.path());
    write(
        dir.path(),
        REBOOT_STATUS,
        r#"{"reboot_required":true,"pending_since_ms":5,"days_pending":1,"consecutive_skips":0,"alert_due":false,"last_check_ms":5,"last_decision":"pending"}"#,
    );
    write(dir.path(), BACKUP_STATUS, "not json");
    let sample = json_of(&collector(dir.path(), &new_session_id().unwrap()).sample(1_000_000));
    assert_eq!(availability(&sample["maintenance"]["reboot"]), "available");
    assert_eq!(sample["maintenance"]["reboot"]["reboot_required"], true);
    assert_eq!(availability(&sample["maintenance"]["backup"]), "error");

    // Nothing at all under the root: every source fails on its own metric.
    let empty = tempfile::tempdir().unwrap();
    let sample = collector(empty.path(), &new_session_id().unwrap()).sample(1_000_000);
    assert_eq!(locally_valid(&sample), Ok(()));
    let value = json_of(&sample);
    assert_eq!(availability(&value["cpu"]["load1"]), "error");
    assert_eq!(availability(&value["memory"]["total"]), "error");
    assert!(value["identity"]["hostname"].is_null());
    assert_eq!(value["filesystems"], json!([]));
}

#[test]
fn permission_denied_stays_on_its_own_source() {
    let dir = tempfile::tempdir().unwrap();
    console(dir.path());
    write(dir.path(), REBOOT_STATUS, "{}");
    for rel in [
        "proc/meminfo",
        REBOOT_STATUS,
        "var/lib/factory-devices/smart.json",
    ] {
        fs::set_permissions(dir.path().join(rel), fs::Permissions::from_mode(0o000)).unwrap();
    }
    if fs::read(dir.path().join("proc/meminfo")).is_ok() {
        eprintln!("skipped: running with CAP_DAC_OVERRIDE");
        return;
    }
    let sample = collector(dir.path(), &new_session_id().unwrap()).sample(1_000_000);
    assert_eq!(locally_valid(&sample), Ok(()));
    let value = json_of(&sample);
    assert_eq!(availability(&value["memory"]["total"]), "permission_denied");
    assert_eq!(
        availability(&value["maintenance"]["reboot"]),
        "permission_denied"
    );
    assert_eq!(value["collector"]["smart"], "permission_denied");
    assert_eq!(
        availability(&value["drives"][0]["smart"]),
        "permission_denied"
    );
    // Unrelated readings stay good.
    assert_eq!(value["cpu"]["load1"]["value"], 0.1);
    assert_eq!(value["cpu"]["temperature"]["value"], 51.0);
}

#[test]
fn hostile_sensor_values_fail_only_that_metric() {
    let dir = tempfile::tempdir().unwrap();
    console(dir.path());
    // Out of range, non-finite, and two chips with the same sensor name.
    write(dir.path(), "sys/class/hwmon/hwmon0/temp2_input", "999999\n");
    write(dir.path(), "sys/class/hwmon/hwmon0/temp2_label", "Core 0\n");
    write(dir.path(), "sys/class/hwmon/hwmon1/name", "applesmc\n");
    write(dir.path(), "sys/class/hwmon/hwmon1/fan1_input", "inf\n");
    write(dir.path(), "sys/class/hwmon/hwmon1/fan2_input", "1800\n");
    write(dir.path(), "sys/class/hwmon/hwmon2/name", "jc42\n");
    write(dir.path(), "sys/class/hwmon/hwmon2/temp1_input", "30000\n");
    write(dir.path(), "sys/class/hwmon/hwmon3/name", "jc42\n");
    write(dir.path(), "sys/class/hwmon/hwmon3/temp1_input", "31000\n");
    write(
        dir.path(),
        "var/lib/factory-devices/smart.json",
        r#"{"drives":[{"kernel":"nvme0n1","passed":true,"temperature_c":200,"available_spare_percent":100,"spare_threshold_percent":250,"media_errors":0.5}]}"#,
    );
    let sample = collector(dir.path(), &new_session_id().unwrap()).sample(1_000_000);
    assert_eq!(locally_valid(&sample), Ok(()));
    let value = json_of(&sample);
    let temps = value["cooling"]["temperatures"].as_array().unwrap();
    let by_name = |name: &str| temps.iter().find(|t| t["name"] == name).unwrap()["metric"].clone();
    assert_eq!(availability(&by_name("coretemp Core 0")), "error");
    assert!(by_name("coretemp Core 0")["value"].is_null());
    assert_eq!(by_name("coretemp Package id 0")["value"], 51.0);
    assert_eq!(by_name("jc42 jc42 temp1")["value"], 30.0);
    assert_eq!(by_name("jc42 jc42 temp1 #2")["value"], 31.0);
    let fans = value["cooling"]["fans"].as_array().unwrap();
    assert_eq!(availability(&fans[0]["metric"]), "error");
    assert_eq!(fans[1]["metric"]["value"], 1800.0);
    let drive = &value["drives"][0];
    assert_eq!(availability(&drive["temperature"]), "error");
    assert_eq!(availability(&drive["media_errors"]), "error");
    assert!(drive["spare_threshold_percent"].is_null());
    assert_eq!(drive["available_spare"]["value"], 100.0);
}

#[test]
fn clock_failure_is_an_error_not_unsynchronized() {
    let dir = tempfile::tempdir().unwrap();
    console(dir.path());
    fn broken() -> Option<bool> {
        None
    }
    fn unsynced() -> Option<bool> {
        Some(false)
    }
    for (clock, expected, synchronized) in [
        (broken as fn() -> Option<bool>, "error", Value::Null),
        (unsynced, "available", json!(false)),
    ] {
        let mut agent = Collector::new(
            Sources {
                root: dir.path().into(),
                clock,
                probe_timeout: Duration::from_millis(500),
            },
            "s".into(),
        );
        let value = json_of(&agent.sample(1_000_000));
        assert_eq!(availability(&value["maintenance"]["clock"]), expected);
        assert_eq!(value["maintenance"]["clock"]["synchronized"], synchronized);
    }
}

#[test]
fn overmounted_and_long_values_are_conformed() {
    let dir = tempfile::tempdir().unwrap();
    console(dir.path());
    let long = "x".repeat(300);
    write(
        dir.path(),
        "proc/self/mountinfo",
        &format!(
            "36 35 259:2 / / ro - ext4 /dev/nvme0n1p2 rw\n\
             37 36 259:3 / /home rw - ext4 /dev/nvme0n1p3 rw\n\
             38 37 0:25 /systemd/inaccessible/dir /home ro - tmpfs tmpfs rw\n\
             39 36 259:4 / /srv/{long} rw - ext4 /dev/nvme0n1p4 rw\n"
        ),
    );
    let sample = collector(dir.path(), &new_session_id().unwrap()).sample(1_000_000);
    assert_eq!(locally_valid(&sample), Ok(()));
    let value = json_of(&sample);
    let mounts: Vec<_> = value["filesystems"]
        .as_array()
        .unwrap()
        .iter()
        .map(|fs| fs["mountpoint"].as_str().unwrap().len())
        .collect();
    // "/" stays, ProtectHome's covered /home is dropped, the long one is clipped.
    assert_eq!(mounts, [1, 256]);
}

#[test]
fn restart_is_a_new_session_and_retries_dedupe_on_the_server() {
    let dir = tempfile::tempdir().unwrap();
    console(dir.path());
    let mut buffer = Buffer::new(BUFFER_CAP);
    let mut first = collector(dir.path(), &new_session_id().unwrap());
    buffer.push(first.sample(1_000_000));
    let (seq, body1) = buffer.next_body(1_000_100).unwrap();
    let (_, body2) = buffer.next_body(1_000_900).unwrap();
    let (a, b): (Value, Value) = (
        serde_json::from_slice(&body1).unwrap(),
        serde_json::from_slice(&body2).unwrap(),
    );
    // A retry is the same sample: only sent_at_ms changes.
    assert_eq!(seq, 1);
    for key in ["session_id", "seq", "observed_at_ms"] {
        assert_eq!(a[key], b[key]);
    }
    assert_ne!(a["sent_at_ms"], b["sent_at_ms"]);
    let stored = devices_ingest::parse(&body1, DEVICE_ID, 1_000_100).unwrap();
    assert_eq!(
        devices_ingest::decide(None, &stored, 1_000_100),
        Outcome::Stored { fresh: true }
    );
    let last = Last {
        observed_at_ms: stored.observed_at_ms,
        session_id: Some(stored.session_id.clone()),
        seq: Some(stored.seq),
    };
    let retry = devices_ingest::parse(&body2, DEVICE_ID, 1_000_900).unwrap();
    assert_eq!(
        devices_ingest::decide(Some(&last), &retry, 1_000_900),
        Outcome::Ignored("duplicate")
    );
    // Restart: new session, seq from 1, accepted because it is newer.
    let mut second = collector(dir.path(), &new_session_id().unwrap());
    let restarted = second.sample(1_020_000);
    assert_eq!(restarted.seq, 1);
    assert_ne!(restarted.session_id, stored.session_id);
    let body = serde_json::to_vec(&restarted).unwrap();
    let parsed = devices_ingest::parse(&body, DEVICE_ID, 1_020_000).unwrap();
    assert_eq!(
        devices_ingest::decide(Some(&last), &parsed, 1_020_000),
        Outcome::Stored { fresh: true }
    );
}

#[test]
fn buffer_is_bounded_and_drops_the_oldest() {
    let dir = tempfile::tempdir().unwrap();
    console(dir.path());
    let mut agent = collector(dir.path(), &new_session_id().unwrap());
    let mut buffer = Buffer::new(BUFFER_CAP);
    for i in 0..(BUFFER_CAP as i64 + 5) {
        buffer.push(agent.sample(1_000_000 + i * 15_000));
    }
    assert_eq!(buffer.len(), BUFFER_CAP);
    assert_eq!(buffer.evicted, 5);
    assert_eq!(buffer.seqs()[0], 6);
    // An in-flight sample that was evicted meanwhile is not mistaken for the front.
    buffer.done(1);
    assert_eq!(buffer.len(), BUFFER_CAP);
    buffer.done(6);
    assert_eq!(buffer.seqs()[0], 7);
}

#[test]
fn every_contract_response_is_classified() {
    let err = |code: &str| {
        format!(r#"{{"error":{{"code":"{code}","message":"m","field":"cpu.utilization"}}}}"#)
    };
    let stored = br#"{"result":"stored","reason":null}"#;
    assert_eq!(
        classify(200, None, stored),
        Verdict::Accepted {
            result: "stored".into(),
            reason: None
        }
    );
    for reason in ["duplicate", "out_of_order", "expired"] {
        let body = format!(r#"{{"result":"ignored","reason":"{reason}"}}"#);
        assert_eq!(
            classify(200, None, body.as_bytes()),
            Verdict::Accepted {
                result: "ignored".into(),
                reason: Some(reason.into())
            }
        );
    }
    for (status, code) in [
        (400, "invalid_json"),
        (400, "unsupported_schema_version"),
        (400, "missing_field"),
        (400, "invalid_field"),
        (400, "invalid_metric"),
        (400, "too_many_items"),
        (400, "server_owned_field"),
        (400, "clock_skew"),
        (400, "device_mismatch"),
        (403, "cross_site"),
        (405, "method_not_allowed"),
        (413, "body_too_large"),
        (415, "unsupported_media_type"),
    ] {
        let verdict = classify(status, None, err(code).as_bytes());
        if code == "cross_site" {
            // 403 cannot be told apart from forbidden_device before reading;
            // both wait for an operator, which is safe for a client that never sets it.
            assert!(
                matches!(verdict, Verdict::Hold { status: 403, .. }),
                "{code}"
            );
            continue;
        }
        assert_eq!(
            verdict,
            Verdict::Rejected {
                status,
                code: code.into(),
                field: Some("cpu.utilization".into())
            },
            "{code}"
        );
    }
    for (status, code) in [
        (401, "unauthorized"),
        (403, "forbidden_device"),
        (404, "not_found"),
    ] {
        assert_eq!(
            classify(status, None, err(code).as_bytes()),
            Verdict::Hold {
                status,
                code: code.into()
            }
        );
    }
    assert_eq!(
        classify(429, Some("7"), err("rate_limited").as_bytes()),
        Verdict::Retry {
            why: "HTTP 429".into(),
            after: Some(Duration::from_secs(7))
        }
    );
    for status in [500, 502, 503, 504] {
        assert!(
            matches!(
                classify(status, None, b""),
                Verdict::Retry { after: None, .. }
            ),
            "{status}"
        );
    }
}

#[test]
fn backoff_is_full_jitter_bounded_and_honors_retry_after() {
    let timing = Timing::default();
    let mut backoff = Backoff::new(42);
    let mut ceilings = vec![];
    for attempt in 0..12 {
        let delay = backoff.next(&timing, None);
        let ceiling = Duration::from_secs(1u64 << attempt.min(6)).min(timing.backoff_max);
        assert!(
            delay >= timing.backoff_min && delay <= ceiling,
            "{attempt}: {delay:?}"
        );
        ceilings.push(ceiling);
    }
    assert_eq!(*ceilings.last().unwrap(), Duration::from_secs(60));
    // Jitter: not all the capped delays are equal.
    let capped: Vec<_> = (0..8).map(|_| backoff.next(&timing, None)).collect();
    assert!(capped.windows(2).any(|w| w[0] != w[1]));
    backoff.reset();
    assert!(backoff.next(&timing, None) <= Duration::from_secs(1));
    assert!(backoff.next(&timing, Some(Duration::from_secs(30))) >= Duration::from_secs(30));
    assert_eq!(
        backoff.next(&timing, Some(Duration::from_secs(900))),
        Duration::from_secs(60)
    );
}

#[test]
fn token_is_validated_and_never_formatted() {
    let token = Token::parse(&format!("{TOKEN}\n")).unwrap();
    assert_eq!(format!("{token:?}"), "Token(redacted)");
    assert!(Token::parse("fdv1_short").is_none());
    assert!(Token::parse(&TOKEN.replace("fdv1_", "fdv2_")).is_none());
    assert!(Token::parse(&format!("{}+", &TOKEN[..47])).is_none());
}

#[test]
fn api_url_must_be_https_except_loopback() {
    let token = || Token::parse(TOKEN).unwrap();
    let ok = Uploader::new(
        "https://factory-gpu.bearded-pompano.ts.net",
        token(),
        Timing::default(),
    )
    .unwrap();
    assert_eq!(
        ok.url.as_str(),
        "https://factory-gpu.bearded-pompano.ts.net/v1/devices/factory-console/samples"
    );
    assert!(Uploader::new("http://127.0.0.1:9", token(), Timing::default()).is_ok());
    assert!(
        Uploader::new(
            "http://factory-gpu.bearded-pompano.ts.net",
            token(),
            Timing::default()
        )
        .is_err()
    );
    assert!(Uploader::new("https://u:p@example.test", token(), Timing::default()).is_err());
}

/// One scripted reply: status, Retry-After, body, delay in ms.
type Reply = (u16, Option<&'static str>, String, u64);

/// Fake factory-api: replies from a script, then 200 stored; records requests.
#[derive(Clone, Default)]
struct Fake {
    script: Arc<Mutex<Vec<Reply>>>,
    seen: Arc<Mutex<Vec<(Value, bool)>>>,
}

async fn ingest(State(fake): State<Fake>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    let sample: Value = serde_json::from_slice(&body).unwrap_or_default();
    let authorized = headers.get("authorization").and_then(|v| v.to_str().ok())
        == Some(&format!("Bearer {TOKEN}"))
        && headers.get("content-type").and_then(|v| v.to_str().ok()) == Some("application/json");
    fake.seen.lock().unwrap().push((sample.clone(), authorized));
    let next = {
        let mut script = fake.script.lock().unwrap();
        (!script.is_empty()).then(|| script.remove(0))
    };
    let (status, retry_after, body, delay) = next.unwrap_or((
        200,
        None,
        json!({"result":"stored","seq":sample["seq"],"reason":null}).to_string(),
        0,
    ));
    tokio::time::sleep(Duration::from_millis(delay)).await;
    let mut response = (StatusCode::from_u16(status).unwrap(), body).into_response();
    if let Some(after) = retry_after {
        response
            .headers_mut()
            .insert("retry-after", after.parse().unwrap());
    }
    response
}

async fn serve(fake: Fake) -> String {
    let app = Router::new()
        .route("/v1/devices/factory-console/samples", post(ingest))
        .with_state(fake);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{address}")
}

fn quick() -> Timing {
    Timing {
        fast: Duration::from_millis(40),
        attempt_timeout: Duration::from_millis(200),
        backoff_min: Duration::from_millis(5),
        backoff_max: Duration::from_millis(20),
        auth_retry: Duration::from_millis(150),
        auth_log: Duration::from_secs(3600),
    }
}

struct Running {
    fake: Fake,
    shutdown: CancellationToken,
    handle: tokio::task::JoinHandle<Summary>,
    _dir: tempfile::TempDir,
}

async fn start(script: Vec<Reply>, timing: Timing, cap: usize) -> Running {
    let dir = tempfile::tempdir().unwrap();
    console(dir.path());
    let fake = Fake::default();
    *fake.script.lock().unwrap() = script;
    let api = serve(fake.clone()).await;
    let uploader = Uploader::new(&api, Token::parse(TOKEN).unwrap(), timing).unwrap();
    let shutdown = CancellationToken::new();
    let handle = tokio::spawn(run(
        collector(dir.path(), &new_session_id().unwrap()),
        uploader,
        cap,
        shutdown.clone(),
    ));
    Running {
        fake,
        shutdown,
        handle,
        _dir: dir,
    }
}

impl Running {
    fn seen(&self) -> Vec<(i64, i64, i64)> {
        self.fake
            .seen
            .lock()
            .unwrap()
            .iter()
            .map(|(s, authorized)| {
                assert!(
                    authorized,
                    "bearer token and JSON content type on every request"
                );
                (
                    s["seq"].as_i64().unwrap(),
                    s["observed_at_ms"].as_i64().unwrap(),
                    s["sent_at_ms"].as_i64().unwrap(),
                )
            })
            .collect()
    }

    async fn until(&self, done: impl Fn(&[(i64, i64, i64)]) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !done(&self.seen()) {
            assert!(
                Instant::now() < deadline,
                "timed out; saw {:?}",
                self.seen()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn stop(self) -> (Summary, Vec<(i64, i64, i64)>) {
        let started = Instant::now();
        self.shutdown.cancel();
        let seen_before = self.seen();
        let summary = self.handle.await.unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "shutdown is prompt"
        );
        (summary, seen_before)
    }
}

fn error(code: &str) -> String {
    json!({"error":{"code":code,"message":"m","field":"cpu.utilization"}}).to_string()
}

#[tokio::test]
async fn retryable_failures_resend_the_same_sample() {
    let script = vec![
        (503, None, error("overloaded"), 0),
        (500, None, error("internal"), 0),
        (429, Some("0"), error("rate_limited"), 0),
        (504, None, error("request_timeout"), 0),
    ];
    let agent = start(script, quick(), BUFFER_CAP).await;
    agent.until(|seen| seen.iter().any(|s| s.0 == 2)).await;
    let (summary, seen) = agent.stop().await;
    let first: Vec<_> = seen.iter().take_while(|s| s.0 == 1).collect();
    assert_eq!(first.len(), 5, "four retries then success: {seen:?}");
    assert!(
        first.iter().all(|s| s.1 == first[0].1),
        "same observed_at_ms"
    );
    assert!(
        first.windows(2).all(|w| w[0].2 <= w[1].2),
        "sent_at_ms moves forward"
    );
    // Seq 2 is sent only after seq 1 was accepted; its own reply may still be in flight.
    assert!(summary.accepted >= 1);
}

#[tokio::test]
async fn non_retryable_rejections_drop_the_sample() {
    let script = vec![
        (400, None, error("invalid_metric"), 0),
        (413, None, error("body_too_large"), 0),
        (415, None, error("unsupported_media_type"), 0),
        (405, None, error("method_not_allowed"), 0),
    ];
    let agent = start(script, quick(), BUFFER_CAP).await;
    agent.until(|seen| seen.iter().any(|s| s.0 == 5)).await;
    let (summary, seen) = agent.stop().await;
    let seqs: Vec<_> = seen.iter().map(|s| s.0).take(5).collect();
    assert_eq!(seqs, [1, 2, 3, 4, 5], "each rejected sample is sent once");
    assert_eq!(summary.rejected, 4);
}

#[tokio::test]
async fn auth_failure_keeps_sampling_and_drains_oldest_first() {
    let script = vec![
        (401, None, error("unauthorized"), 0),
        (403, None, error("forbidden_device"), 0),
    ];
    let agent = start(script, quick(), BUFFER_CAP).await;
    agent.until(|seen| seen.len() >= 6).await;
    let (_, seen) = agent.stop().await;
    let seqs: Vec<_> = seen.iter().map(|s| s.0).collect();
    // Held twice on seq 1, slowly (auth_retry, not backoff); samples kept meanwhile.
    assert_eq!(&seqs[..3], [1, 1, 1]);
    let gap = seen[1].2 - seen[0].2;
    assert!(gap >= 140, "held for auth_retry, not backoff: {gap} ms");
    assert!(
        seqs.windows(2).all(|w| w[0] <= w[1]),
        "oldest first: {seqs:?}"
    );
    assert!(
        seqs[3..].windows(2).all(|w| w[1] == w[0] + 1),
        "no gaps after recovery: {seqs:?}"
    );
}

#[tokio::test]
async fn hanging_server_is_bounded_by_the_attempt_timeout() {
    let script = vec![
        (200, None, "{}".into(), 10_000),
        (200, None, "{}".into(), 10_000),
    ];
    let agent = start(script, quick(), BUFFER_CAP).await;
    agent.until(|seen| seen.len() >= 3).await;
    let (_, seen) = agent.stop().await;
    assert_eq!(
        (seen[0].0, seen[1].0),
        (1, 1),
        "a timed out attempt is retried"
    );
    let gap = seen[1].2 - seen[0].2;
    assert!(
        (190..2_000).contains(&gap),
        "attempt bounded by 200 ms timeout: {gap} ms"
    );
}

#[tokio::test]
async fn shutdown_mid_upload_is_prompt_and_buffer_stays_bounded() {
    let script = (0..1000)
        .map(|_| (503, None, error("overloaded"), 0))
        .collect();
    let agent = start(script, quick(), 3).await;
    agent.until(|seen| seen.iter().any(|s| s.0 >= 6)).await;
    let (summary, _) = agent.stop().await;
    assert!(summary.evicted >= 3, "{summary:?}");
    assert!(summary.discarded_on_exit <= 3, "{summary:?}");
    assert_eq!(summary.accepted, 0);

    let hang = vec![(200, None, "{}".into(), 10_000)];
    let mut timing = quick();
    timing.attempt_timeout = Duration::from_secs(30);
    let agent = start(hang, timing, BUFFER_CAP).await;
    agent.until(|seen| !seen.is_empty()).await;
    let fake = agent.fake.clone();
    let (summary, _) = agent.stop().await;
    assert_eq!(summary.accepted, 0);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(
        fake.seen.lock().unwrap().len(),
        1,
        "nothing sent after shutdown"
    );
}

#[test]
fn capabilities_name_every_source() {
    let dir = tempfile::tempdir().unwrap();
    console(dir.path());
    let mut sample = collector(dir.path(), &new_session_id().unwrap()).sample(1_000_000);
    let rows = capabilities(&mut sample);
    let find = |path: &str| rows.iter().find(|r| r.0 == path).map(|r| r.1);
    assert_eq!(find("cooling.fans"), Some(Availability::Unsupported));
    assert_eq!(find("maintenance.backup"), Some(Availability::Unsupported));
    assert_eq!(find("drives[nvme0n1].smart"), Some(Availability::Available));
    assert_eq!(find("cpu.temperature"), Some(Availability::Available));
    assert_eq!(find("cpu.utilization"), Some(Availability::Stale));
}

/// Run a sample on a thread so a non-terminating collector fails the test
/// instead of hanging it.
fn sample_within(root: &Path, limit: Duration) -> DeviceSampleV1 {
    let root = root.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let sample = collector(&root, &new_session_id().unwrap()).sample(1_000_000);
        let _ = tx.send(sample);
    });
    rx.recv_timeout(limit).expect("sample finished")
}

#[test]
fn long_multibyte_sensor_collisions_stay_unique_and_terminate() {
    let dir = tempfile::tempdir().unwrap();
    console(dir.path());
    // "a" + 130 two-byte chars: 261 bytes, so the 256-byte cut lands mid-char.
    let chip = format!("a{}", "é".repeat(130));
    for index in 1..=4 {
        let base = format!("sys/class/hwmon/hwmon{index}");
        write(dir.path(), &format!("{base}/name"), &format!("{chip}\n"));
        write(
            dir.path(),
            &format!("{base}/temp1_input"),
            &format!("{}000\n", 30 + index),
        );
        write(dir.path(), &format!("{base}/fan1_input"), "1200\n");
    }
    let sample = sample_within(dir.path(), Duration::from_secs(10));
    assert_eq!(locally_valid(&sample), Ok(()));
    let body = serde_json::to_vec(&sample).unwrap();
    assert!(String::from_utf8(body).is_ok());
    for list in [&sample.cooling.temperatures, &sample.cooling.fans] {
        let long: Vec<_> = list.iter().filter(|t| t.name.starts_with("aé")).collect();
        assert_eq!(long.len(), 4);
        let names: std::collections::BTreeSet<_> = long.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names.len(), 4, "unique: {names:?}");
        assert!(long.iter().all(|t| t.name.len() <= 256));
        for n in 2..=4 {
            assert!(
                long.iter().any(|t| t.name.ends_with(&format!(" #{n}"))),
                "#{n}"
            );
        }
    }
    let values: Vec<_> = sample
        .cooling
        .temperatures
        .iter()
        .filter(|t| t.name.starts_with("aé"))
        .map(|t| t.metric.value)
        .collect();
    assert_eq!(values, [Some(31.0), Some(32.0), Some(33.0), Some(34.0)]);
}

#[test]
fn maintenance_integers_outside_the_contract_fail_only_that_source() {
    let max = 9_007_199_254_740_991_i64;
    let reboot = |days: &str, since: &str| {
        format!(
            r#"{{"reboot_required":false,"pending_since_ms":{since},"days_pending":{days},"consecutive_skips":0,"alert_due":false,"last_check_ms":0,"last_decision":"not-needed"}}"#
        )
    };
    let backup = |at: &str| {
        format!(r#"{{"console":{{"last_success_ms":{at},"last_attempt_ms":0,"error":null}}}}"#)
    };
    let cases = [
        (
            reboot("0", &max.to_string()),
            backup(&max.to_string()),
            "available",
            "available",
        ),
        (reboot("-1", "0"), backup("0"), "error", "available"),
        (
            reboot("0", &(max + 1).to_string()),
            backup("-1"),
            "error",
            "error",
        ),
        (
            reboot("0", "0"),
            backup(&(max + 1).to_string()),
            "available",
            "error",
        ),
    ];
    for (reboot_body, backup_body, reboot_state, backup_state) in cases {
        let dir = tempfile::tempdir().unwrap();
        console(dir.path());
        write(dir.path(), REBOOT_STATUS, &reboot_body);
        write(dir.path(), BACKUP_STATUS, &backup_body);
        let sample = collector(dir.path(), &new_session_id().unwrap()).sample(1_000_000);
        assert_eq!(
            locally_valid(&sample),
            Ok(()),
            "{reboot_body} {backup_body}"
        );
        let value = json_of(&sample);
        let m = &value["maintenance"];
        assert_eq!(availability(&m["reboot"]), reboot_state, "{reboot_body}");
        assert_eq!(availability(&m["backup"]), backup_state, "{backup_body}");
        if reboot_state == "available" {
            assert_eq!(m["reboot"]["last_check_ms"], 0);
        } else {
            assert!(
                m["reboot"]["days_pending"].is_null() && m["reboot"]["pending_since_ms"].is_null()
            );
            assert_eq!(m["reboot"]["detail"], "integer outside 0 to 2^53-1");
        }
        if backup_state == "error" {
            assert!(m["backup"]["last_success_ms"].is_null());
        }
        // The rest of the sample is kept.
        assert_eq!(value["cpu"]["load1"]["value"], 0.1);
        assert_eq!(availability(&value["memory"]["total"]), "available");
    }
    // Boundary values themselves are sent as-is.
    let dir = tempfile::tempdir().unwrap();
    console(dir.path());
    write(dir.path(), REBOOT_STATUS, &reboot("0", &max.to_string()));
    write(dir.path(), BACKUP_STATUS, &backup(&max.to_string()));
    let value = json_of(&collector(dir.path(), &new_session_id().unwrap()).sample(1_000_000));
    assert_eq!(value["maintenance"]["reboot"]["pending_since_ms"], max);
    assert_eq!(value["maintenance"]["backup"]["last_success_ms"], max);
}

/// A raw HTTP server that reads one full request, sends `head` with a larger
/// Content-Length than the bytes it writes, then closes or stalls.
async fn incomplete(head: String, stall: bool) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            let read = socket.read(&mut chunk).await.unwrap();
            request.extend_from_slice(&chunk[..read]);
            let text = String::from_utf8_lossy(&request).to_ascii_lowercase();
            if let Some(end) = text.find("\r\n\r\n") {
                let length: usize = text
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .map_or(0, |v| v.trim().parse().unwrap());
                if request.len() >= end + 4 + length {
                    break;
                }
            }
            assert!(read > 0, "client closed early");
        }
        socket.write_all(head.as_bytes()).await.unwrap();
        socket.write_all(br#"{"error":{"code":"inv"#).await.unwrap();
        socket.flush().await.unwrap();
        if stall {
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
    format!("http://{address}")
}

#[tokio::test]
async fn incomplete_response_bodies_keep_the_status_decision() {
    let dir = tempfile::tempdir().unwrap();
    console(dir.path());
    let mut agent = collector(dir.path(), &new_session_id().unwrap());
    let body = serde_json::to_vec(&agent.sample(now_ms())).unwrap();
    type Expect = fn(&Verdict) -> bool;
    let cases: [(u16, &str, Expect); 8] = [
        (400, "", |v| {
            matches!(v, Verdict::Rejected { status: 400, .. })
        }),
        (413, "", |v| {
            matches!(v, Verdict::Rejected { status: 413, .. })
        }),
        (415, "", |v| {
            matches!(v, Verdict::Rejected { status: 415, .. })
        }),
        (401, "", |v| matches!(v, Verdict::Hold { status: 401, .. })),
        (403, "", |v| matches!(v, Verdict::Hold { status: 403, .. })),
        (503, "", |v| matches!(v, Verdict::Retry { after: None, .. })),
        (
            429,
            "Retry-After: 3\r\n",
            |v| matches!(v, Verdict::Retry { after: Some(d), .. } if *d == Duration::from_secs(3)),
        ),
        (200, "", |v| matches!(v, Verdict::Accepted { .. })),
    ];
    for stall in [false, true] {
        for (status, extra, expected) in cases {
            let head = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n{extra}Connection: close\r\n\r\n"
            );
            let api = incomplete(head, stall).await;
            let mut timing = quick();
            timing.attempt_timeout = Duration::from_millis(300);
            let uploader = Uploader::new(&api, Token::parse(TOKEN).unwrap(), timing).unwrap();
            let started = Instant::now();
            let verdict = uploader.send(body.clone()).await;
            assert!(
                expected(&verdict),
                "status {status} stall {stall}: {verdict:?}"
            );
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "bounded by the attempt timeout"
            );
        }
    }
}

/// hwmon0..hwmon2, each named with the same 256-byte name and temp1..temp8
/// inputs. With `fifo` the inputs are FIFOs with no writer, so every read
/// blocks until the probe timeout and slow inventory runs for about 24 s.
fn hwmon_fixture(root: &Path, fifo: bool) {
    console(root);
    fs::remove_dir_all(root.join("sys/class/hwmon")).unwrap();
    let name = "a".repeat(256);
    for chip in 0..3 {
        let base = format!("sys/class/hwmon/hwmon{chip}");
        write(root, &format!("{base}/name"), &format!("{name}\n"));
        for index in 1..=8 {
            let path = root.join(format!("{base}/temp{index}_input"));
            if fifo {
                let c = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
                assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
            } else {
                fs::write(path, "31000\n").unwrap();
            }
        }
    }
}

async fn counting_api() -> (String, Arc<Mutex<Vec<Instant>>>) {
    let arrivals = Arc::new(Mutex::new(Vec::new()));
    let seen = arrivals.clone();
    let app = Router::new().route(
        "/v1/devices/factory-console/samples",
        post(move || {
            let seen = seen.clone();
            async move {
                seen.lock().unwrap().push(Instant::now());
                json!({"result":"stored","reason":null}).to_string()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}"), arrivals)
}

/// Run the real binary, signal it once `ready` holds, and require it to exit by
/// itself, successfully, well inside the unit's 15 s TimeoutStopSec, with no
/// upload arriving after the signal.
async fn signal_real_process(
    fifo: bool,
    signal: i32,
    ready: fn(&[Instant], &str) -> bool,
) -> Duration {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("root");
    hwmon_fixture(&root, fifo);
    let cred = dir.path().join("cred");
    fs::create_dir(&cred).unwrap();
    fs::write(cred.join("token"), format!("{TOKEN}\n")).unwrap();
    let log_path = dir.path().join("agent.log");
    let (api, arrivals) = counting_api().await;
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_factory-devices-agent"))
        .args(["--api", &api, "--root", root.to_str().unwrap()])
        .env_clear()
        .env("CREDENTIALS_DIRECTORY", &cred)
        .env("RUST_LOG", "factory_devices_agent=debug")
        .stdout(fs::File::create(&log_path).unwrap())
        .stderr(fs::File::create(dir.path().join("agent.err")).unwrap())
        .spawn()
        .unwrap();
    let log = || fs::read_to_string(dir.path().join("agent.err")).unwrap_or_default();
    let deadline = Instant::now() + Duration::from_secs(20);
    while !ready(&arrivals.lock().unwrap(), &log()) {
        assert!(Instant::now() < deadline, "never ready: {}", log());
        assert!(
            child.try_wait().unwrap().is_none(),
            "exited early: {}",
            log()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let signalled = Instant::now();
    assert_eq!(unsafe { libc::kill(child.id() as i32, signal) }, 0);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if signalled.elapsed() > Duration::from_secs(12) {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!(
                "still alive 12 s after signal {signal}; needed SIGKILL: {}",
                log()
            );
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let took = signalled.elapsed();
    assert!(status.success(), "exit {status:?}: {}", log());
    assert!(took < Duration::from_secs(5), "took {took:?}");
    tokio::time::sleep(Duration::from_millis(500)).await;
    let late = arrivals
        .lock()
        .unwrap()
        .iter()
        .filter(|at| **at > signalled + Duration::from_millis(200))
        .count();
    assert_eq!(late, 0, "uploads after the signal");
    assert!(log().contains("agent stopped"), "{}", log());
    took
}

#[tokio::test(flavor = "multi_thread")]
async fn signal_stops_the_process_while_blocking_probes_run() {
    // Ready once started; the first sample is still blocked in the FIFO reads.
    fn sampling(arrivals: &[Instant], log: &str) -> bool {
        log.contains("agent started") && arrivals.is_empty()
    }
    fn uploading(arrivals: &[Instant], _: &str) -> bool {
        !arrivals.is_empty()
    }
    let (blocked_term, blocked_int, control) = tokio::join!(
        async {
            // Give collection time to enter the blocking reads.
            tokio::time::sleep(Duration::from_millis(1500)).await;
            signal_real_process(true, libc::SIGTERM, sampling).await
        },
        async {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            signal_real_process(true, libc::SIGINT, sampling).await
        },
        signal_real_process(false, libc::SIGTERM, uploading),
    );
    eprintln!(
        "exit after signal: fifo SIGTERM {blocked_term:?}, fifo SIGINT {blocked_int:?}, control {control:?}"
    );
}
