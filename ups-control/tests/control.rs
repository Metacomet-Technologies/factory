use factory_ups_control::{Config, Control, guard, store::Store};
use reqwest::Client;
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    fs,
    net::{SocketAddr, TcpListener},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::Duration,
};

fn uid() -> u32 {
    fs::read_to_string("/proc/self/status")
        .unwrap()
        .lines()
        .find(|l| l.starts_with("Uid:"))
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap()
}

#[test]
fn proc_fixtures_and_guard_fail_closed() {
    let header = "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n";
    let v4 = format!(
        "{header}0: 0100007F:C123 0100007F:1F9A 01 00000000:00000000 00:00000000 00000000 1234 0 99\n1: 0100007F:1F9A 0100007F:C123 01 00000000:00000000 00:00000000 00000000 999 0 100\n"
    );
    let peer: SocketAddr = "127.0.0.1:49443".parse().unwrap();
    let local = "127.0.0.1:8090".parse().unwrap();
    assert_eq!(guard::owner(&v4, peer, local), Some(1234));
    assert_eq!(guard::owner(&v4.replace(" 01 ", " 06 "), peer, local), None);
    assert_eq!(
        guard::owner(&v4.replace("0100007F:C123", "0200007F:C123"), peer, local),
        None
    );
    assert_eq!(guard::owner("malformed\n", peer, local), None);
    let v6 = format!(
        "{header}0: 00000000000000000000000001000000:C123 00000000000000000000000001000000:1F9A 01 0:0 00:0 0 77 0 12\n"
    );
    assert_eq!(
        guard::owner(
            &v6,
            "[::1]:49443".parse().unwrap(),
            "[::1]:8090".parse().unwrap()
        ),
        Some(77)
    );
    let allowed: Vec<String> = vec!["DGarbs51@github".into()];
    assert!(guard::authorize(
        peer,
        Some(0),
        0,
        Some(&allowed[0]),
        &allowed
    ));
    for (address, owner, login) in [
        (peer, Some(12), Some("DGarbs51@github")),
        (peer, None, Some("DGarbs51@github")),
        (peer, Some(0), None),
        (peer, Some(0), Some("other")),
        (
            "192.0.2.1:49443".parse().unwrap(),
            Some(0),
            Some("DGarbs51@github"),
        ),
    ] {
        assert!(!guard::authorize(address, owner, 0, login, &allowed));
    }
}

struct Harness {
    dir: tempfile::TempDir,
    children: Vec<Child>,
    server: tokio::task::JoinHandle<()>,
    control: Arc<Control>,
    client: Client,
    url: String,
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.server.abort();
        for child in &mut self.children {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
fn port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

impl Harness {
    async fn new(trusted: u32) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("ups-status"), "OL").unwrap();
        fs::write(root.join("serve-login"), "DGarbs51@github").unwrap();
        fs::create_dir(root.join("credentials")).unwrap();
        fs::write(
            root.join("credentials/nut-password"),
            "test-secret-nut-NEVER-LOG",
        )
        .unwrap();
        fs::write(
            root.join("credentials/slack-bot-token"),
            "test-secret-slack-NEVER-LOG",
        )
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let listen = listener.local_addr().unwrap();
        let (nut, slack) = (port(), port());
        let shims = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/sandbox-shims");
        let children = vec![
            Command::new("python3")
                .arg(shims.join("fake-upsd.py"))
                .arg(nut.to_string())
                .arg(root.join("ups-status"))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
            Command::new("python3")
                .arg(shims.join("fake-serve.py"))
                .arg(slack.to_string())
                .arg(listen.port().to_string())
                .arg(root)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        ];
        for p in [nut, slack] {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            loop {
                if tokio::net::TcpStream::connect(("127.0.0.1", p))
                    .await
                    .is_ok()
                {
                    break;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "fake failed to start"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        let db_path = root.join("audit.db");
        Store::open(db_path.clone(), true)
            .await
            .unwrap()
            .0
            .close()
            .await
            .unwrap();
        let control = Control::open(Config {
            db_path,
            listen,
            nut_addr: format!("127.0.0.1:{nut}").parse().unwrap(),
            trusted_peer_uid: trusted,
            allowed_logins: vec!["DGarbs51@github".into(), "metacometdave@github".into()],
            hostname: "synthetic-host".into(),
            boot_id: "test-boot".into(),
            credential_dir: root.join("credentials"),
            slack_url: format!("http://127.0.0.1:{slack}/slack/chat.postMessage"),
        })
        .await
        .unwrap();
        let router = control.router();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        Self {
            dir,
            children,
            server,
            control,
            client: Client::builder().no_proxy().build().unwrap(),
            url: format!("http://{listen}"),
        }
    }
    async fn request(&self, path: &str, login: Option<&str>, body: Option<Value>) -> (u16, Value) {
        let mut request = if let Some(body) = body {
            self.client.post(format!("{}{path}", self.url)).json(&body)
        } else {
            self.client.get(format!("{}{path}", self.url))
        };
        if let Some(login) = login {
            request = request.header("Tailscale-User-Login", login);
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap())
    }
    async fn prepare(&self, name: &str, value: Option<&str>) -> (u16, Value) {
        self.request(
            "/v1/actions",
            Some("DGarbs51@github"),
            Some(json!({"action":name,"value":value})),
        )
        .await
    }
    async fn confirm(&self, pending: &Value) -> (u16, Value) {
        self.request(
            &format!("/v1/actions/{}/confirm", pending["id"]),
            Some("DGarbs51@github"),
            Some(json!({"phrase":pending["confirm_phrase"]})),
        )
        .await
    }
    fn fixture(&self, values: Value) {
        fs::write(self.dir.path().join("ups-values.json"), values.to_string()).unwrap();
    }
    fn sql(&self, sql: &str) {
        Connection::open(self.dir.path().join("audit.db"))
            .unwrap()
            .execute_batch(sql)
            .unwrap();
    }
    fn received(&self) -> String {
        fs::read_to_string(self.dir.path().join("ups-received.log")).unwrap_or_default()
    }
}

#[tokio::test]
async fn real_socket_guard_and_notification_throttle() {
    let h = Harness::new(uid() + 1).await;
    assert_eq!(
        h.request("/v1/state", Some("DGarbs51@github"), None)
            .await
            .0,
        403
    );
    assert_eq!(
        h.request(
            "/v1/actions",
            Some("DGarbs51@github"),
            Some(json!({"action":"power.cycle"}))
        )
        .await
        .0,
        403
    );
    h.control.flush_notifications().await.unwrap();
    assert_eq!(
        fs::read_to_string(h.dir.path().join("slack-posts.jsonl"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    assert_eq!(h.control.store.rows(20, i64::MAX).await.unwrap().len(), 2);
    assert!(h.received().is_empty());
    let h = Harness::new(uid()).await;
    assert_eq!(h.request("/v1/state", None, None).await.0, 403);
    assert_eq!(
        h.request("/v1/state", Some("other@github"), None).await.0,
        403
    );
    let (status, state) = h.request("/v1/state", Some("DGarbs51@github"), None).await;
    assert_eq!(status, 200);
    assert_eq!(state["login"], "DGarbs51@github");
    assert!(
        state["actions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["action"] == "power.off_stay" && a["enabled"] == false)
    );
    for _ in 1..30 {
        assert_eq!(
            h.request("/v1/audit", Some("DGarbs51@github"), None)
                .await
                .0,
            200
        );
    }
    for (path, body) in [
        ("/v1/state", None),
        ("/v1/audit", None),
        ("/v1/actions", Some(json!({"action":"beeper.mute"}))),
        (
            "/v1/actions/1/confirm",
            Some(json!({"phrase":"confirm beeper.mute"})),
        ),
    ] {
        assert_eq!(h.request(path, Some("DGarbs51@github"), body).await.0, 429);
    }
}

#[tokio::test]
async fn denial_flood_preserves_allowed_actions_and_aggregates_audit() {
    let h = Harness::new(uid()).await;
    let mut flood = tokio::task::JoinSet::new();
    for _ in 0..512 {
        let (client, url) = (h.client.clone(), h.url.clone());
        flood.spawn(async move {
            client
                .get(format!("{url}/v1/state"))
                .header("Tailscale-User-Login", "forged@github")
                .timeout(Duration::from_secs(30))
                .send()
                .await
                .unwrap()
                .status()
                .as_u16()
        });
    }
    // Exercise allowed traffic while the denied requests are in flight.
    assert_eq!(
        h.request("/v1/state", Some("DGarbs51@github"), None)
            .await
            .0,
        200
    );
    let (status, pending) = h.prepare("test.quick", None).await;
    assert_eq!(status, 200, "{pending}");
    let (status, result) = h.confirm(&pending).await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(result["executed"], true);
    while let Some(status) = flood.join_next().await {
        assert_eq!(status.unwrap(), 403);
    }
    let rows = h.control.store.rows(100, i64::MAX).await.unwrap();
    assert_eq!(rows.iter().filter(|r| r.event == "guard-deny").count(), 8);
    assert!(
        rows.iter().any(|r| r.event == "execute"
            && r.action.as_deref() == Some("test.quick")
            && r.executed)
    );

    // Advance only the monotonic audit window; no minute-long test sleep.
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(61)).await;
    tokio::time::resume();
    h.control.flush_notifications().await.unwrap();
    h.control.flush_notifications().await.unwrap();
    let rows = h.control.store.rows(100, i64::MAX).await.unwrap();
    assert_eq!(rows.iter().filter(|r| r.event == "guard-deny").count(), 9);
    assert_eq!(
        rows.iter()
            .filter(
                |r| r.result == "suppressed 504 guard denials in preceding audit window"
                    && r.login.is_none()
            )
            .count(),
        1
    );
    assert_eq!(h.request("/v1/state", None, None).await.0, 403);
    assert_eq!(
        h.control
            .store
            .rows(100, i64::MAX)
            .await
            .unwrap()
            .iter()
            .filter(|r| r.event == "guard-deny")
            .count(),
        10
    );
    h.control.flush_notifications().await.unwrap();
    // Wall time has not advanced: samples and summary still share one Slack allowance.
    let posts = fs::read_to_string(h.dir.path().join("slack-posts.jsonl")).unwrap();
    assert_eq!(
        posts
            .lines()
            .filter(|line| line.contains("guard-deny"))
            .count(),
        1
    );
}

#[tokio::test]
async fn confirmation_owner_phrase_expiry_reuse_cooldown_and_credentials() {
    let h = Harness::new(uid()).await;
    let csrf = h
        .client
        .post(format!("{}/v1/actions", h.url))
        .header("Tailscale-User-Login", "DGarbs51@github")
        .header("Content-Type", "text/plain")
        .body(r#"{"action":"power.cycle"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(csrf.status().as_u16(), 409);
    let csrf = h
        .client
        .post(format!("{}/v1/actions", h.url))
        .header("Tailscale-User-Login", "DGarbs51@github")
        .header("Sec-Fetch-Site", "cross-site")
        .json(&json!({"action":"power.cycle"}))
        .send()
        .await
        .unwrap();
    assert_eq!(csrf.status().as_u16(), 409);
    assert!(h.received().is_empty());
    let (status, pending) = h.prepare("test.quick", None).await;
    assert_eq!(status, 200);
    let path = format!("/v1/actions/{}/confirm", pending["id"]);
    for (login, phrase) in [
        ("DGarbs51@github", "wrong"),
        ("metacometdave@github", "confirm test.quick"),
    ] {
        assert_eq!(
            h.request(&path, Some(login), Some(json!({"phrase":phrase})))
                .await
                .0,
            409
        );
    }
    assert_eq!(h.confirm(&pending).await.0, 200);
    assert_eq!(h.confirm(&pending).await.0, 409);
    assert_eq!(h.prepare("test.quick", None).await.0, 409);
    assert_eq!(
        h.received()
            .matches("INSTCMD cyberpower test.battery.start.quick")
            .count(),
        1
    );
    let (status, pending) = h.prepare("beeper.mute", None).await;
    assert_eq!(status, 200);
    h.sql("UPDATE confirmations SET expires_ms=1 WHERE action='beeper.mute'");
    assert_eq!(h.confirm(&pending).await.0, 409);
    let audit = h
        .request("/v1/audit?limit=100", Some("DGarbs51@github"), None)
        .await
        .1
        .to_string();
    let posts = fs::read_to_string(h.dir.path().join("slack-posts.jsonl")).unwrap();
    for secret in ["test-secret-nut-NEVER-LOG", "test-secret-slack-NEVER-LOG"] {
        assert!(
            !audit.contains(secret) && !posts.contains(secret) && !h.received().contains(secret)
        );
        for child in &h.children {
            assert!(
                !String::from_utf8_lossy(
                    &fs::read(format!("/proc/{}/cmdline", child.id())).unwrap()
                )
                .contains(secret)
            );
        }
    }
}

#[tokio::test]
async fn exact_allowlist_and_settings_boundaries() {
    for (name, value, expected) in [
        ("test.stop", None, "INSTCMD cyberpower test.battery.stop"),
        ("beeper.enable", None, "INSTCMD cyberpower beeper.enable"),
        ("beeper.disable", None, "INSTCMD cyberpower beeper.disable"),
        ("beeper.mute", None, "INSTCMD cyberpower beeper.mute"),
        ("shutdown.stop", None, "INSTCMD cyberpower shutdown.stop"),
        (
            "input.sensitivity",
            Some("high"),
            "SET VAR cyberpower input.sensitivity \"high\"",
        ),
        (
            "input.transfer.low",
            Some("90"),
            "SET VAR cyberpower input.transfer.low \"90\"",
        ),
        (
            "input.transfer.high",
            Some("140"),
            "SET VAR cyberpower input.transfer.high \"140\"",
        ),
        (
            "ups.delay.shutdown",
            Some("30"),
            "SET VAR cyberpower ups.delay.shutdown \"30\"",
        ),
        (
            "ups.delay.start",
            Some("0"),
            "SET VAR cyberpower ups.delay.start \"0\"",
        ),
    ] {
        let h = Harness::new(uid()).await;
        let (status, pending) = h.prepare(name, value).await;
        assert_eq!(status, 200, "{name}: {pending}");
        assert_eq!(h.confirm(&pending).await.0, 200, "{name}");
        assert!(h.received().lines().any(|l| l == expected), "{name}");
        if value.is_some() {
            let rows = h.control.store.rows(20, i64::MAX).await.unwrap();
            let executed = rows.iter().find(|r| r.event == "execute").unwrap();
            assert!(executed.old_value.is_some());
            assert_eq!(executed.value.as_deref(), value);
        }
    }
    let h = Harness::new(uid()).await;
    for forbidden in [
        "load.off",
        "load.on",
        "load.off.delay",
        "load.on.delay",
        "driver.killpower",
        "test.battery.start.deep",
        "driver.reload",
        "driver.reload-or-error",
        "driver.reload-or-exit",
        "shutdown.default",
        "shutdown.return",
        "shutdown.stayoff",
        "driver.flag.allow_killpower",
        "power.off_stay",
        "beeper.mute\nFSD cyberpower",
    ] {
        assert_eq!(h.prepare(forbidden, None).await.0, 409, "{forbidden}");
    }
    assert!(!h.received().contains("INSTCMD") && !h.received().contains("FSD"));
    let h = Harness::new(uid()).await;
    for (name, value) in [
        ("input.sensitivity", "extreme"),
        ("input.sensitivity", "high\"\nFSD cyberpower"),
        ("input.transfer.low", "89"),
        ("input.transfer.low", "106"),
        ("input.transfer.high", "129"),
        ("input.transfer.high", "141"),
        ("ups.delay.shutdown", "29"),
        ("ups.delay.shutdown", "601"),
        ("ups.delay.start", "-1"),
        ("ups.delay.start", "601"),
    ] {
        assert_eq!(h.prepare(name, Some(value)).await.0, 409, "{name}={value}");
    }
    fs::write(
        h.dir.path().join("ups-ranges.json"),
        r#"{"input.transfer.low":[[95,103]],"input.transfer.high":[[104,150]]}"#,
    )
    .unwrap();
    let (_, state) = h.request("/v1/state", Some("DGarbs51@github"), None).await;
    assert_eq!(
        state["settings"]["input.transfer.low"]["range_source"],
        "upsd"
    );
    assert_eq!(h.prepare("input.transfer.low", Some("94")).await.0, 409);
    assert_eq!(h.prepare("input.transfer.low", Some("95")).await.0, 200);
    assert_eq!(h.prepare("input.transfer.low", Some("103")).await.0, 200);
    assert_eq!(h.prepare("input.transfer.low", Some("104")).await.0, 409);
    h.fixture(json!({"input.transfer.low":"104"}));
    assert_eq!(h.prepare("input.transfer.high", Some("104")).await.0, 409);
    assert_eq!(h.prepare("input.transfer.high", Some("105")).await.0, 200);
    assert_eq!(h.prepare("input.transfer.high", Some("150")).await.0, 200);
    assert_eq!(h.prepare("input.transfer.high", Some("151")).await.0, 409);
}

#[tokio::test]
async fn power_preflight_rechecked_and_pending_survives_restart() {
    let h = Harness::new(uid()).await;
    for status in ["OB DISCHRG", "OL LB", "OB DISCHRG LB"] {
        fs::write(h.dir.path().join("ups-status"), status).unwrap();
        assert_eq!(h.prepare("power.cycle", None).await.0, 409);
    }
    fs::write(h.dir.path().join("ups-status"), "OL").unwrap();
    let pending = h.prepare("power.cycle", None).await.1;
    assert_eq!(pending["confirm_phrase"], "power-cycle synthetic-host");
    fs::write(h.dir.path().join("ups-status"), "OB DISCHRG").unwrap();
    assert_eq!(h.confirm(&pending).await.0, 409);
    assert!(!h.received().contains("FSD"));
    fs::write(h.dir.path().join("ups-status"), "OL").unwrap();
    let pending = h.prepare("power.cycle", None).await.1;
    let (status, result) = h.confirm(&pending).await;
    assert_eq!(status, 200, "{result}");
    assert!(
        result["expected_downtime"]
            .as_str()
            .unwrap()
            .contains("5–15")
    );
    assert_eq!(
        h.received()
            .lines()
            .filter(|l| *l == "FSD cyberpower")
            .count(),
        1
    );
    assert_eq!(h.prepare("power.cycle", None).await.0, 409);
    h.sql("UPDATE audit SET ts_ms=1 WHERE action='power.cycle' AND attempted=1");
    assert!(
        h.prepare("power.cycle", None).await.1["error"]
            .as_str()
            .unwrap()
            .contains("pending")
    );
    // A separate pool simulates another process/restart; reservation is not memory-only.
    let reopened = Store::open(h.dir.path().join("audit.db"), false)
        .await
        .unwrap();
    assert!(
        reopened
            .rows(100, i64::MAX)
            .await
            .unwrap()
            .iter()
            .any(|r| r.action.as_deref() == Some("power.cycle")
                && r.attempted
                && !r.executed
                && r.boot_id == "test-boot")
    );
    reopened.0.close().await.unwrap();
}

#[tokio::test]
async fn quick_and_scheduled_tests_accept_only_known_idle_results() {
    for result in [
        "Done and passed",
        "Done and warning",
        "DONE AND ERROR",
        "Aborted",
        "nO TeSt InItIaTeD",
    ] {
        // Independent instances avoid the successful API call's ten-minute cooldown.
        for scheduled in [false, true] {
            let h = Harness::new(uid()).await;
            h.fixture(json!({"ups.test.result":result}));
            if scheduled {
                assert!(h.control.selftest(3600.0).await.unwrap()["executed"] == true);
            } else {
                let (status, pending) = h.prepare("test.quick", None).await;
                assert_eq!(status, 200, "{result}: {pending}");
                assert_eq!(h.confirm(&pending).await.0, 200, "{result}");
            }
        }
    }
    let h = Harness::new(uid()).await;
    for result in [
        Some("Test scheduled"),
        Some("In progress"),
        Some("unknown"),
        Some("Done something else"),
        Some("No test mystery"),
        None,
    ] {
        h.fixture(json!({"ups.test.result":result}));
        assert_eq!(h.prepare("test.quick", None).await.0, 409, "{result:?}");
        assert!(h.control.selftest(3600.0).await.is_err(), "{result:?}");
    }
    assert!(!h.received().contains("INSTCMD"));
}

#[tokio::test]
async fn quick_and_scheduled_preflight_migrations_and_strict_schema() {
    let h = Harness::new(uid()).await;
    let action_lock = fs::File::create(h.dir.path().join("audit.action.lock")).unwrap();
    action_lock.try_lock().unwrap();
    assert!(h.control.selftest(3600.0).await.is_err());
    let rows = h.control.store.rows(20, i64::MAX).await.unwrap();
    assert!(rows.iter().any(|r| r.event == "refuse"
        && r.login.as_deref() == Some("scheduled")
        && r.result.contains("another action is in progress")));
    assert!(
        fs::read_to_string(h.dir.path().join("slack-posts.jsonl"))
            .unwrap()
            .contains("another action is in progress")
    );
    drop(action_lock);
    assert!(h.control.selftest(3599.99).await.is_err());
    for values in [
        json!({"battery.charge":"99"}),
        json!({"ups.test.result":"Test in progress"}),
        json!({"ups.test.result":"unknown"}),
        json!({"ups.status":"OL CHRG"}),
    ] {
        h.fixture(values);
        assert_eq!(h.prepare("test.quick", None).await.0, 409);
        assert!(h.control.selftest(3600.0).await.is_err());
    }
    h.fixture(json!({}));
    assert!(h.control.selftest(3600.0).await.is_ok());
    assert!(h.control.selftest(3600.0).await.is_err());
    assert_eq!(
        h.received()
            .matches("INSTCMD cyberpower test.battery.start.quick")
            .count(),
        1
    );
    let db = Connection::open(h.dir.path().join("audit.db")).unwrap();
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    for table in ["audit", "confirmations"] {
        assert_eq!(
            db.query_row(
                "SELECT strict FROM pragma_table_list WHERE name=?",
                [table],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
    assert!(
        db.execute(
            "INSERT INTO audit(ts_ms,event,result,boot_id) VALUES('bad','execute','ok','boot')",
            []
        )
        .is_err()
    );
    assert!(
        db.execute(
            "INSERT INTO audit(ts_ms,event,result,boot_id) VALUES(-1,'execute','ok','boot')",
            []
        )
        .is_err()
    );
    drop(db);
    h.server.abort();
    h.control.store.0.close().await.unwrap();
    let rerun = Store::open(h.dir.path().join("audit.db"), true)
        .await
        .unwrap();
    assert!(!rerun.rows(100, i64::MAX).await.unwrap().is_empty());
    rerun.0.close().await.unwrap();
    h.sql("PRAGMA user_version=2");
    assert!(
        Store::open(h.dir.path().join("audit.db"), true)
            .await
            .is_err()
    );
    assert!(
        Store::open(h.dir.path().join("audit.db"), false)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn tracking_success_failure_pending_timeout_and_plain_ok() {
    for (mode, http, expected, executed) in [
        ("SUCCESS", 200, "SUCCESS", true),
        ("FAILURE", 409, "FAILURE", false),
        ("PENDING", 202, "PENDING", false),
        ("PLAIN_OK", 409, "FAILURE", false),
    ] {
        let h = Harness::new(uid()).await;
        fs::write(h.dir.path().join("ups-tracking"), mode).unwrap();
        let (status, pending) = h.prepare("input.sensitivity", Some("high")).await;
        assert_eq!(status, 200);
        let started = std::time::Instant::now();
        let (status, response) = h.confirm(&pending).await;
        assert_eq!(status, http, "{mode}: {response}");
        assert_eq!(response["executed"], executed);
        assert_eq!(response["tracking_status"], expected);
        if mode == "PENDING" {
            assert!(started.elapsed() >= Duration::from_secs(10));
        }
        let rows = h.control.store.rows(100, i64::MAX).await.unwrap();
        let row = rows.iter().find(|r| r.attempted).unwrap();
        assert_eq!(row.executed, executed);
        assert_eq!(row.event, if executed { "execute" } else { "refuse" });
        assert_eq!(row.tracking_status.as_deref(), Some(expected));
        assert!(row.result.contains(if executed {
            "executed:"
        } else {
            "not executed"
        }));
        let posts = fs::read_to_string(h.dir.path().join("slack-posts.jsonl")).unwrap();
        assert!(posts.contains(if executed {
            "driver tracking SUCCESS"
        } else {
            "not executed"
        }));
        let received = h.received();
        assert!(received.contains("SET TRACKING ON"));
        if mode != "PLAIN_OK" {
            assert!(received.contains("GET TRACKING "));
        }
        let state = h
            .request("/v1/state", Some("DGarbs51@github"), None)
            .await
            .1;
        assert_eq!(
            state["settings"]["input.sensitivity"]["value"],
            if executed { "high" } else { "normal" }
        );
        assert_eq!(h.confirm(&pending).await.0, 409);
        assert_eq!(
            h.received()
                .matches("SET VAR cyberpower input.sensitivity")
                .count(),
            1
        );
    }
}
