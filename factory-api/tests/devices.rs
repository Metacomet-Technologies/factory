use axum::http::StatusCode;
use factory_api::{AppState, devices, fleet, now_ms, router};
use serde_json::Value;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

fn write(root: &Path, rel: &str, body: &str) {
    let path = root.join(rel);
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
        " 259 0 nvme0n1 1 0 100 0 1 0 50 0 0 0 0 0\n",
    );
    write(
        root,
        "proc/net/dev",
        "Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\n",
    );
    write(root, "proc/sys/kernel/hostname", "factory-gpu\n");
    write(root, "proc/sys/kernel/random/boot_id", "boot-a\n");
    write(
        root,
        "proc/self/mountinfo",
        "36 35 98:0 / / rw - ext4 /dev/nvme0n1p2 rw\n37 35 0:5 / /proc rw - proc proc rw\n",
    );
    write(root, "sys/fs/factory-mountstat", "/\t1000\t400\t100\t20\n");
    write(root, "sys/block/nvme0n1/size", "2048\n");
    write(root, "sys/block/nvme0n1/device/wwid", "wwn-abc\n");
    write(root, "sys/class/hwmon/hwmon0/name", "k10temp\n");
    write(root, "sys/class/hwmon/hwmon0/temp1_input", "45000\n");
    write(
        root,
        "var/lib/factory-devices/smart.json",
        r#"{"observed_at_ms":10,"drives":[{"id":"wwn-abc","kernel":"nvme0n1","passed":true,"available_spare_percent":100,"spare_threshold_percent":10,"media_errors":0,"media_critical":false}]}"#,
    );
    write(
        root,
        "var/lib/factory-backup-status/status.json",
        r#"{"meter":{"last_success_ms":10,"last_attempt_ms":12,"error":null}}"#,
    );
    write(
        root,
        "var/lib/factory-reboot/status.json",
        r#"{"reboot_required":true,"pending_since_ms":1000,"days_pending":3,"consecutive_skips":1,"alert_due":false,"last_check_ms":2000,"last_decision":"skipped"}"#,
    );
}

async fn serve(app: axum::Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, task)
}

#[tokio::test]
async fn fixture_api_keeps_nulls_partial_failure_and_history_bounds() {
    let directory = tempfile::tempdir().unwrap();
    pricing::migrate(directory.path().join("pricing.db")).unwrap();
    fixture(directory.path());
    let mut state = AppState::new(
        "http://127.0.0.1:1".into(),
        directory.path().join("requests.db"),
        directory.path().join("pricing.db"),
        fleet::Config { nodes: vec![] },
    )
    .await
    .unwrap();
    state.devices_root = directory.path().to_path_buf();
    state.backup_status = directory
        .path()
        .join("var/lib/factory-backup-status/status.json");
    state.reboot_status = directory.path().join("var/lib/factory-reboot/status.json");
    state
        .db
        .clock_synchronized
        .store(true, std::sync::atomic::Ordering::Release);
    let mut sampler = devices::Sampler::default();
    state.collect_devices(&mut sampler).await;
    write(
        directory.path(),
        "proc/stat",
        "cpu  300 0 300 1600 0 0 0 0 0 0\n",
    );
    tokio::time::sleep(std::time::Duration::from_secs(6)).await;
    state.collect_devices(&mut sampler).await;

    let scope = factory_db::Scope::default();
    let (url, server) = serve(router(state.clone()).layer(axum::Extension(scope.clone()))).await;
    let client = reqwest::Client::new();
    let list: Value = client
        .get(format!("{url}/v1/devices"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list["devices"][0]["device_id"], "factory-gpu");
    assert_eq!(scope.counts().data, 0);

    let current_scope = factory_db::Scope::default();
    let (url, current_server) =
        serve(router(state.clone()).layer(axum::Extension(current_scope.clone()))).await;
    let current: Value = client
        .get(format!("{url}/v1/devices/factory-gpu"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        current["device"]["cpu"]["utilization"]["value"]
            .as_f64()
            .unwrap()
            > 0.0
    );
    assert_eq!(current["device"]["memory"]["swap_total"]["value"], 0.0);
    assert_eq!(
        current["device"]["gpus"][0]["utilization"]["value"],
        Value::Null
    );
    assert_eq!(
        current["device"]["maintenance"]["reboot"]["days_pending"],
        3
    );
    assert_eq!(
        current["device"]["maintenance"]["backup"]["last_success_ms"],
        10
    );
    assert_eq!(current["device"]["maintenance"]["ups"]["href"], "/ups");
    assert_eq!(current_scope.counts().data, 0);
    current_server.abort();

    let history_scope = factory_db::Scope::default();
    let (url, history_server) =
        serve(router(state.clone()).layer(axum::Extension(history_scope.clone()))).await;
    let history: Value = client
        .get(format!("{url}/v1/devices/factory-gpu/history?range=1h"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let points = history["points"].as_array().unwrap();
    assert!(points.len() >= 2);
    assert!(points.len() <= 720);
    assert!(
        points
            .iter()
            .any(|point| point["cpu_percent"]["avg"].is_null())
    );
    assert!(
        points
            .iter()
            .any(|point| point["cpu_percent"]["avg"].as_f64().is_some())
    );
    assert_eq!(history_scope.counts().data, 1);
    history_server.abort();
    server.abort();

    write(directory.path(), "proc/meminfo", "not meminfo\n");
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    write(
        directory.path(),
        "proc/stat",
        "cpu  400 0 400 2000 0 0 0 0 0 0\n",
    );
    state.collect_devices(&mut sampler).await;
    let (url, partial) = serve(router(state.clone())).await;
    let body: Value = client
        .get(format!("{url}/v1/devices/factory-gpu"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        body["device"]["cpu"]["utilization"]["value"]
            .as_f64()
            .is_some()
    );
    assert_eq!(body["device"]["memory"]["total"]["value"], Value::Null);
    assert_eq!(body["device"]["memory"]["total"]["availability"], "error");
    partial.abort();

    let denied = directory.path().join("var/lib/factory-reboot/status.json");
    fs::set_permissions(&denied, fs::Permissions::from_mode(0o000)).unwrap();
    let mut cold = devices::Sampler::default();
    state.collect_devices(&mut cold).await;
    let (url, reboot) = serve(router(state)).await;
    let body: Value = client
        .get(format!("{url}/v1/devices/factory-gpu"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        body["device"]["maintenance"]["reboot"]["availability"],
        "permission_denied"
    );
    assert_eq!(
        body["device"]["maintenance"]["reboot"]["days_pending"],
        Value::Null
    );
    assert_ne!(body["device"]["health"]["status"], "healthy");
    let _ = now_ms();
    reboot.abort();
}

#[tokio::test]
async fn history_rejects_other_ranges() {
    let directory = tempfile::tempdir().unwrap();
    pricing::migrate(directory.path().join("pricing.db")).unwrap();
    let state = AppState::new(
        "http://127.0.0.1:1".into(),
        directory.path().join("requests.db"),
        directory.path().join("pricing.db"),
        fleet::Config { nodes: vec![] },
    )
    .await
    .unwrap();
    let (url, server) = serve(router(state)).await;
    let response = reqwest::get(format!("{url}/v1/devices/factory-gpu/history?range=2h"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    server.abort();
}

#[test]
fn reboot_status_defaults_to_the_published_copy() {
    assert_eq!(
        devices::DEFAULT_REBOOT_STATUS,
        "/var/lib/factory-reboot-status/status.json"
    );
    let help = std::process::Command::new(env!("CARGO_BIN_EXE_factory-api"))
        .env_clear()
        .arg("--help")
        .output()
        .unwrap();
    assert!(help.status.success());
    let text = String::from_utf8(help.stdout).unwrap();
    assert!(text.contains("[default: /var/lib/factory-reboot-status/status.json]"));
    assert!(text.contains("FACTORY_API_REBOOT_STATUS"));
}
