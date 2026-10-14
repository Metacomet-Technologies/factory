pub mod guard;
mod nut;
pub mod store;

use anyhow::{Context, Result, bail, ensure};
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{ConnectInfo, Request, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
};
use factory_db::Scope;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    net::SocketAddr,
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

pub const OFF_STAY_REASON: &str = "Disabled: the final NUT shutdown hook selects shutdown.return; an earlier stay-off command can be overridden and can cut power before OS halt.";
const SETTINGS: [&str; 5] = [
    "input.sensitivity",
    "input.transfer.low",
    "input.transfer.high",
    "ups.delay.shutdown",
    "ups.delay.start",
];
const ACTIONS: [&str; 13] = [
    "test.quick",
    "test.stop",
    "beeper.enable",
    "beeper.disable",
    "beeper.mute",
    "shutdown.stop",
    "input.sensitivity",
    "input.transfer.low",
    "input.transfer.high",
    "ups.delay.shutdown",
    "ups.delay.start",
    "power.cycle",
    "power.off_stay",
];

#[derive(Clone)]
pub struct Config {
    pub db_path: PathBuf,
    pub listen: SocketAddr,
    pub nut_addr: SocketAddr,
    pub trusted_peer_uid: u32,
    pub allowed_logins: Vec<String>,
    pub hostname: String,
    pub boot_id: String,
    pub credential_dir: PathBuf,
    pub slack_url: String,
}

pub struct Control {
    pub store: store::Store,
    config: Config,
    nut: nut::Nut,
    slack_token: String,
    client: reqwest::Client,
    rates: Mutex<(Instant, BTreeMap<String, u32>)>,
    guard_denials: Mutex<GuardDenials>,
    notifications: Mutex<()>,
}

struct GuardDenials {
    window: tokio::time::Instant,
    recorded: u32,
    suppressed: u64,
}

impl Default for GuardDenials {
    fn default() -> Self {
        Self {
            window: tokio::time::Instant::now(),
            recorded: 0,
            suppressed: 0,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Action {
    pub action: String,
    pub value: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Confirmation {
    phrase: String,
}

#[derive(Serialize)]
struct Setting {
    value: String,
    allowed_values: Vec<String>,
    ranges: Vec<[i64; 2]>,
    range_source: &'static str,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_millis() as i64
}

fn tier(action: &str) -> &'static str {
    if action.starts_with("power.") {
        "power"
    } else if SETTINGS.contains(&action) {
        "settings"
    } else {
        "safe"
    }
}

fn phrase(action: &str, hostname: &str) -> String {
    match action {
        "power.cycle" => format!("power-cycle {hostname}"),
        "power.off_stay" => format!("power-off-stay {hostname}"),
        _ => format!("confirm {action}"),
    }
}

fn valid_action(action: &Action) -> Result<()> {
    ensure!(
        ACTIONS.contains(&action.action.as_str()),
        "action not allowlisted"
    );
    ensure!(action.action != "power.off_stay", "{OFF_STAY_REASON}");
    if SETTINGS.contains(&action.action.as_str()) {
        let value = action.value.as_deref().context("setting requires value")?;
        ensure!(
            !value.is_empty()
                && value.len() <= 64
                && value
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-'),
            "invalid setting value"
        );
    } else {
        ensure!(action.value.is_none(), "action takes no value");
    }
    Ok(())
}

fn command(action: &Action) -> Result<String> {
    valid_action(action)?;
    Ok(match action.action.as_str() {
        "test.quick" => "INSTCMD cyberpower test.battery.start.quick".into(),
        "test.stop" => "INSTCMD cyberpower test.battery.stop".into(),
        "beeper.enable" | "beeper.disable" | "beeper.mute" | "shutdown.stop" => {
            format!("INSTCMD cyberpower {}", action.action)
        }
        "power.cycle" => "FSD cyberpower".into(),
        name if SETTINGS.contains(&name) => format!(
            "SET VAR cyberpower {name} {}",
            nut::quote(action.value.as_deref().context("missing value")?)
        ),
        _ => bail!("action not allowlisted"),
    })
}

fn lock(path: &std::path::Path) -> Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    file.try_lock().context("another action is in progress")?;
    Ok(file)
}

pub fn migration_lock(path: &std::path::Path) -> Result<File> {
    lock(&path.with_extension("daemon.lock"))
}

impl Control {
    pub async fn open(config: Config) -> Result<Arc<Self>> {
        ensure!(
            config.listen.ip().is_loopback(),
            "listener must be loopback"
        );
        ensure!(
            !config.allowed_logins.is_empty()
                && config
                    .allowed_logins
                    .iter()
                    .all(|s| !s.is_empty() && s.len() <= 256),
            "invalid allowed logins"
        );
        let credential = |name: &str| -> Result<String> {
            let raw = std::fs::read_to_string(config.credential_dir.join(name))
                .context("credential unavailable")?;
            Ok(raw.trim_end_matches(['\r', '\n']).to_owned())
        };
        let nut = nut::Nut::new(config.nut_addr, credential("nut-password")?)?;
        let slack_token = credential("slack-bot-token")?;
        ensure!(
            !slack_token.is_empty()
                && slack_token.len() <= 512
                && slack_token.bytes().all(|b| b.is_ascii_graphic()),
            "invalid Slack credential"
        );
        let url = reqwest::Url::parse(&config.slack_url)?;
        ensure!(
            config.slack_url == "https://slack.com/api/chat.postMessage"
                || (url.scheme() == "http"
                    && url
                        .host_str()
                        .is_some_and(|h| h == "127.0.0.1" || h == "[::1]")),
            "Slack override must be loopback HTTP"
        );
        Ok(Arc::new(Self {
            store: store::Store::open(config.db_path.clone(), false).await?,
            config,
            nut,
            slack_token,
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(3))
                .build()?,
            rates: Mutex::new((Instant::now(), BTreeMap::new())),
            guard_denials: Mutex::new(GuardDenials::default()),
            notifications: Mutex::new(()),
        }))
    }

    pub fn router(self: &Arc<Self>) -> Router {
        Router::new().fallback(handle).with_state(self.clone())
    }

    async fn audit(
        &self,
        event: &str,
        login: Option<&str>,
        action: Option<&Action>,
        result: &str,
        old: Option<String>,
        notify: bool,
    ) -> Result<i64> {
        self.store
            .append(
                store::Row {
                    id: 0,
                    ts_ms: now_ms(),
                    event: event.into(),
                    login: login.map(str::to_owned),
                    action: action.map(|a| a.action.clone()),
                    value: action.and_then(|a| a.value.clone()),
                    old_value: old,
                    result: result.into(),
                    nut_response: None,
                    boot_id: self.config.boot_id.clone(),
                    attempted: event == "dispatch",
                    executed: false,
                    tracking_status: None,
                    tracking_id: None,
                },
                notify,
            )
            .await
    }

    async fn guard_denial(&self, login: Option<&str>) -> Result<()> {
        // Hold this lock through the write: denied callers can occupy at most
        // one pool slot, independently of the allowed-login request budget.
        let mut denials = self.guard_denials.lock().await;
        if denials.recorded >= 8 {
            denials.suppressed = denials.suppressed.saturating_add(1);
            return Ok(());
        }
        denials.recorded += 1;
        self.audit(
            "guard-deny",
            login,
            None,
            "untrusted peer or identity",
            None,
            true,
        )
        .await?;
        Ok(())
    }

    async fn flush_guard_denials(&self) -> Result<()> {
        let mut denials = self.guard_denials.lock().await;
        if denials.window.elapsed() < Duration::from_secs(60) {
            return Ok(());
        }
        let previous = std::mem::take(&mut *denials);
        if previous.suppressed > 0 {
            self.audit(
                "guard-deny",
                None,
                None,
                &format!(
                    "suppressed {} guard denials in preceding audit window",
                    previous.suppressed
                ),
                None,
                true,
            )
            .await?;
        }
        Ok(())
    }

    async fn settings(
        &self,
        session: &mut nut::Session,
        vars: &BTreeMap<String, String>,
    ) -> Result<BTreeMap<String, Setting>> {
        let mut settings = BTreeMap::new();
        for name in SETTINGS {
            let value = vars
                .get(name)
                .context("writable setting unavailable")?
                .clone();
            let mut values = Vec::new();
            for row in session.list("ENUM", Some(name)).await? {
                ensure!(row.len() == 4, "invalid NUT enum");
                values.push(row[3].clone());
            }
            let mut ranges = Vec::new();
            for row in session.list("RANGE", Some(name)).await? {
                ensure!(row.len() == 5, "invalid NUT range");
                let low: i64 = row[3].parse().context("invalid NUT range")?;
                let high: i64 = row[4].parse().context("invalid NUT range")?;
                ensure!(low <= high, "invalid NUT range");
                ranges.push([low, high]);
            }
            let reported = !ranges.is_empty();
            let policy = match name {
                "input.transfer.low" if !reported => Some([90, 105]),
                "input.transfer.high" if !reported => Some([130, 140]),
                "ups.delay.shutdown" => Some([30, 600]),
                "ups.delay.start" => Some([0, 600]),
                _ => None,
            };
            if let Some([min, max]) = policy {
                if reported {
                    ranges = ranges
                        .into_iter()
                        .map(|[a, b]| [a.max(min), b.min(max)])
                        .filter(|[a, b]| a <= b)
                        .collect();
                } else {
                    ranges.push([min, max]);
                }
            }
            settings.insert(
                name.into(),
                Setting {
                    value,
                    allowed_values: values,
                    ranges,
                    range_source: if reported && policy.is_some() {
                        "upsd (intersected with policy)"
                    } else if reported {
                        "upsd"
                    } else {
                        "policy fallback"
                    },
                },
            );
        }
        Ok(settings)
    }

    async fn snapshot(&self) -> Result<(BTreeMap<String, String>, BTreeMap<String, Setting>)> {
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut session = self.nut.connect().await?;
            let vars = session.variables().await?;
            let settings = self.settings(&mut session, &vars).await?;
            Ok((vars, settings))
        })
        .await
        .context("NUT read timeout")?
    }

    async fn pending(&self) -> Result<Option<Value>> {
        let boot = self.config.boot_id.clone();
        self.store.0.read(&Scope::default(), move |db| {
            Ok(db.query_row("SELECT id,ts_ms,action,result FROM audit WHERE boot_id=? AND action='power.cycle' AND attempted=1 ORDER BY id DESC LIMIT 1", [boot], |r| Ok(json!({"audit_id":r.get::<_,i64>(0)?, "ts_ms":r.get::<_,i64>(1)?, "action":r.get::<_,String>(2)?, "result":r.get::<_,String>(3)?}))).optional()?)
        }).await
    }

    async fn preflight(&self, action: &Action) -> Result<Option<String>> {
        valid_action(action)?;
        let name = action.action.clone();
        let cooldown = if name.starts_with("test.") {
            600_000
        } else if name.starts_with("power.") {
            1_800_000
        } else {
            0
        };
        if cooldown > 0 {
            let cutoff = now_ms() - cooldown;
            let recent: bool = self.store.0.read(&Scope::default(), move |db| Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM audit WHERE action=? AND attempted=1 AND ts_ms>?)", params![name,cutoff], |r| r.get(0))?)).await?;
            ensure!(!recent, "action cooldown active");
        }
        if action.action.starts_with("power.") {
            ensure!(
                self.pending().await?.is_none(),
                "power action pending; FSD cannot be cancelled through this API"
            );
        }
        let (vars, settings) = self.snapshot().await?;
        let status = vars.get("ups.status").context("UPS status unavailable")?;
        if action.action == "test.quick" {
            ensure!(status == "OL", "quick test requires exactly OL");
            ensure!(
                vars.get("battery.charge")
                    .and_then(|v| v.parse::<f64>().ok())
                    == Some(100.0),
                "quick test requires 100% charge"
            );
            let test = vars
                .get("ups.test.result")
                .context("test status unavailable")?
                .to_ascii_lowercase();
            ensure!(
                matches!(
                    test.as_str(),
                    "done and passed"
                        | "done and warning"
                        | "done and error"
                        | "aborted"
                        | "no test initiated"
                ),
                "test running or status unknown"
            );
        }
        if action.action.starts_with("power.") {
            let flags: Vec<_> = status.split_whitespace().collect();
            ensure!(
                !flags.contains(&"OB") && !flags.contains(&"LB"),
                "power action refused on battery or low battery"
            );
            ensure!(
                flags.contains(&"OL") && !flags.contains(&"FSD"),
                "power action requires online non-FSD status"
            );
        }
        if let Some(setting) = settings.get(&action.action) {
            let value = action.value.as_deref().context("missing value")?;
            if action.action == "input.sensitivity" {
                ensure!(
                    setting.allowed_values.iter().any(|v| v == value),
                    "value not in upsd enum"
                );
            } else {
                let number: i64 = value.parse().context("setting must be integer")?;
                ensure!(
                    number.to_string() == value
                        && setting
                            .ranges
                            .iter()
                            .any(|[a, b]| (*a..=*b).contains(&number)),
                    "value outside allowed range"
                );
                if action.action.starts_with("input.transfer.") {
                    let other = if action.action.ends_with("low") {
                        "input.transfer.high"
                    } else {
                        "input.transfer.low"
                    };
                    let other: i64 = vars
                        .get(other)
                        .context("transfer peer unavailable")?
                        .parse()
                        .context("invalid transfer peer")?;
                    ensure!(
                        if action.action.ends_with("low") {
                            number < other
                        } else {
                            other < number
                        },
                        "transfer low must be below high"
                    );
                }
            }
            return Ok(Some(setting.value.clone()));
        }
        Ok(None)
    }

    async fn prepare(&self, login: &str, action: Action) -> Result<Value> {
        // File lock also serializes the independent scheduled process.
        let _lock = lock(&self.config.db_path.with_extension("action.lock"))?;
        valid_action(&action)?;
        self.audit(
            "request",
            Some(login),
            Some(&action),
            "requested",
            None,
            false,
        )
        .await?;
        let attempt: Result<Value> = async {
            self.preflight(&action).await?;
            let phrase = phrase(&action.action, &self.config.hostname);
            let expires = now_ms() + 60_000;
            let (user, saved, confirmation) = (login.to_owned(), action.clone(), phrase.clone());
            let id = self.store.0.write(&Scope::default(), move |db| {
                db.execute("INSERT INTO confirmations(login,action,value,phrase,expires_ms) VALUES(?,?,?,?,?)", params![user,saved.action,saved.value,confirmation,expires])?;
                Ok(db.last_insert_rowid())
            }).await?;
            Ok(json!({"id":id,"confirm_phrase":phrase,"expires_ms":expires}))
        }.await;
        if let Err(ref error) = attempt {
            self.audit(
                "refuse",
                Some(login),
                Some(&action),
                &error.to_string(),
                None,
                false,
            )
            .await?;
        }
        attempt
    }

    async fn confirm(&self, login: &str, id: i64, supplied: String) -> Result<Value> {
        let _lock = lock(&self.config.db_path.with_extension("action.lock"))?;
        let user = login.to_owned();
        let action = self.store.0.write(&Scope::default(), move |db| {
            let row = db.query_row("SELECT login,action,value,phrase,expires_ms,used FROM confirmations WHERE id=?", [id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,String>(3)?,r.get::<_,i64>(4)?,r.get::<_,bool>(5)?))).optional()?.context("confirmation not found")?;
            ensure!(row.0 == user && row.3 == supplied && row.4 > now_ms() && !row.5, "confirmation refused: login, phrase, expiry or reuse");
            db.execute("UPDATE confirmations SET used=1 WHERE id=?", [id])?;
            Ok(Action { action: row.1, value: row.2 })
        }).await?;
        self.audit(
            "confirm",
            Some(login),
            Some(&action),
            "confirmed; ID consumed",
            None,
            false,
        )
        .await?;
        self.execute(login, &action).await
    }

    async fn execute(&self, login: &str, action: &Action) -> Result<Value> {
        let old = match self.preflight(action).await {
            Ok(old) => old,
            Err(error) => {
                self.audit(
                    "refuse",
                    Some(login),
                    Some(action),
                    &error.to_string(),
                    None,
                    login == "scheduled",
                )
                .await?;
                return Err(error);
            }
        };
        let command = command(action)?;
        // Commit before sending: crashes/timeouts never permit an automatic retry,
        // and pending FSD survives daemon restarts until a different boot_id.
        let id = self
            .audit(
                "dispatch",
                Some(login),
                Some(action),
                "outcome unknown (dispatching)",
                old,
                true,
            )
            .await?;
        let outcome = self.nut.execute(&command).await;
        let (status, response, tracking_id) = match outcome {
            Ok(outcome) => (outcome.status, outcome.response, outcome.tracking_id),
            Err(error) => ("FAILURE", error.to_string(), None),
        };
        let executed = status == "SUCCESS";
        let result = match status {
            "SUCCESS" => "executed: driver tracking SUCCESS",
            "FSD_SET" => "FSD latch set; clean shutdown requested, physical completion unverified",
            "PENDING" => {
                "not executed (unconfirmed): tracking PENDING after 10 s; may execute later; do not retry"
            }
            _ => {
                "not executed: tracking FAILURE or unconfirmed submission; do not automatically retry"
            }
        };
        let event = if executed {
            "execute"
        } else if status == "FSD_SET" {
            "dispatch"
        } else {
            "refuse"
        };
        let response_value = json!({"audit_id":id,"executed":executed,"tracking_status":status,"tracking_id":tracking_id,"result":result,"nut_response":response,
            "expected_downtime": if action.action == "power.cycle" { Some("Configured UPS delays plus OS shutdown and boot; budget 5–15 minutes, not a measured guarantee") } else { None }});
        self.store
            .0
            .write(&Scope::default(), move |db| {
                db.execute(
                    "UPDATE audit SET event=?,result=?,nut_response=?,executed=?,tracking_status=?,tracking_id=? WHERE id=?",
                    params![event, result, response, executed, status, tracking_id, id],
                )?;
                Ok(())
            })
            .await?;
        self.flush_notifications().await?;
        Ok(response_value)
    }

    pub async fn selftest(&self, uptime_seconds: f64) -> Result<Value> {
        let action = Action {
            action: "test.quick".into(),
            value: None,
        };
        self.audit(
            "request",
            Some("scheduled"),
            Some(&action),
            "monthly scheduled test",
            None,
            false,
        )
        .await?;
        let _lock = match lock(&self.config.db_path.with_extension("action.lock")) {
            Ok(lock) => lock,
            Err(error) => {
                self.audit(
                    "refuse",
                    Some("scheduled"),
                    Some(&action),
                    &error.to_string(),
                    None,
                    true,
                )
                .await?;
                self.flush_notifications().await?;
                return Err(error);
            }
        };
        if !uptime_seconds.is_finite() || uptime_seconds < 3600.0 {
            self.audit(
                "refuse",
                Some("scheduled"),
                Some(&action),
                "scheduled test requires one hour uptime",
                None,
                true,
            )
            .await?;
            self.flush_notifications().await?;
            bail!("scheduled test requires one hour uptime");
        }
        let result = self.execute("scheduled", &action).await;
        self.flush_notifications().await?;
        let result = result?;
        ensure!(
            result["executed"] == true,
            "scheduled quick test not executed; see audit tracking result"
        );
        Ok(result)
    }

    pub async fn flush_notifications(&self) -> Result<()> {
        let _serial = self.notifications.lock().await;
        // The daemon calls this every ten seconds, even after a flood stops.
        self.flush_guard_denials().await?;
        // Cross-process serialization avoids duplicate concurrent deliveries.
        let Ok(_lock) = lock(&self.config.db_path.with_extension("slack.lock")) else {
            return Ok(());
        };
        let cutoff = now_ms() - 30_000;
        let rows = self.store.0.read(&Scope::default(), move |db| {
            let mut query = db.prepare("SELECT id,ts_ms,event,login,action,value,old_value,result,nut_response,boot_id,attempted,executed,tracking_status,tracking_id FROM audit WHERE notify=1 AND (result != 'outcome unknown (dispatching)' OR ts_ms < ?) ORDER BY id LIMIT 20")?;
            Ok(query.query_map([cutoff], store::read_row)?.collect::<rusqlite::Result<Vec<_>>>()?)
        }).await?;
        for row in rows {
            let text = format!(
                "{} UPS audit #{}: {} · {} · {} · {}",
                self.config.hostname,
                row.id,
                row.event,
                row.login.as_deref().unwrap_or("unidentified"),
                row.action.as_deref().unwrap_or("identity guard"),
                row.result
            )
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
            let sent = async {
                let response = self.client.post(&self.config.slack_url).bearer_auth(&self.slack_token)
                    .json(&json!({"channel":"C0C9N9HCRG8","text":text,"mrkdwn":false,"unfurl_links":false,"unfurl_media":false})).send().await?;
                Ok::<bool, reqwest::Error>(response.status().is_success() && response.json::<Value>().await?["ok"] == true)
            }.await;
            if !matches!(sent, Ok(true)) {
                eprintln!("Slack delivery failed; audit outbox retained");
                break;
            }
            self.store
                .0
                .write(&Scope::default(), move |db| {
                    db.execute("UPDATE audit SET notify=2 WHERE id=?", [row.id])?;
                    Ok(())
                })
                .await?;
        }
        Ok(())
    }
}

fn reply(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"error":message}))).into_response()
}

async fn handle(
    State(control): State<Arc<Control>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    request: Request,
) -> Response {
    let headers = request
        .headers()
        .get_all("Tailscale-User-Login")
        .iter()
        .collect::<Vec<_>>();
    let login = if headers.len() == 1 {
        headers[0].to_str().ok().filter(|s| s.len() <= 256)
    } else {
        None
    };
    // A missing/unlisted identity cannot pass, so do not let it force a /proc scan.
    let uid = if login.is_some_and(|name| control.config.allowed_logins.iter().any(|s| s == name)) {
        guard::socket_owner(peer, control.config.listen).await
    } else {
        None
    };
    if !guard::authorize(
        peer,
        uid,
        control.config.trusted_peer_uid,
        login,
        &control.config.allowed_logins,
    ) {
        // An untrusted header is an assertion, not an authenticated identity.
        if control.guard_denial(login).await.is_err() {
            eprintln!("guard denial audit write failed");
        }
        return reply(StatusCode::FORBIDDEN, "identity guard denied");
    }
    let login = login.unwrap().to_owned();
    {
        let mut rates = control.rates.lock().await;
        if rates.0.elapsed() >= Duration::from_secs(60) {
            *rates = (Instant::now(), BTreeMap::new());
        }
        let count = rates.1.entry(login.clone()).or_default();
        *count += 1;
        if *count > 30 {
            drop(rates);
            let _ = control
                .audit("refuse", Some(&login), None, "rate limit", None, false)
                .await;
            return reply(
                StatusCode::TOO_MANY_REQUESTS,
                "30 requests per login per minute",
            );
        }
    }
    // Detached dispatch finishes a confirmed command even if its HTTP client leaves.
    let task_control = control.clone();
    match tokio::spawn(async move { dispatch(&task_control, &login, request).await }).await {
        Ok(response) => response,
        Err(_) => reply(StatusCode::INTERNAL_SERVER_ERROR, "request failed"),
    }
}

async fn dispatch(control: &Control, login: &str, request: Request) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let query = request.uri().query().unwrap_or("").to_owned();
    let result: Result<Value> = async {
        if method == Method::POST {
            // JSON-only plus no CORS blocks cross-origin form/no-cors CSRF through
            // a legitimate user's Serve identity. Never accept text/plain JSON.
            let content_type = request.headers().get("content-type").and_then(|h| h.to_str().ok()).unwrap_or("");
            ensure!(content_type.split(';').next().unwrap_or("").trim() == "application/json", "application/json required");
            ensure!(request.headers().get("sec-fetch-site").is_none_or(|h| h != "cross-site"), "cross-site mutation refused");
        }
        match (method, path.as_str()) {
            (Method::GET, "/v1/state") => {
                let (vars, settings) = control.snapshot().await?;
                let actions: Vec<_> = ACTIONS.iter().map(|name| json!({"action":name,"tier":tier(name),"confirm_phrase":phrase(name, &control.config.hostname),"enabled":*name != "power.off_stay","disabled_reason":if *name == "power.off_stay" { Some(OFF_STAY_REASON) } else { None }})).collect();
                Ok(json!({"login":login,"actions":actions,"settings":settings,"ups_status":vars.get("ups.status"),"pending_power_action":control.pending().await?,"audit":control.store.rows(20,i64::MAX).await?}))
            }
            (Method::GET, "/v1/audit") => {
                let (mut limit, mut before) = (20, i64::MAX);
                for part in query.split('&').filter(|s| !s.is_empty()) {
                    let (key, value) = part.split_once('=').context("invalid audit query")?;
                    match key { "limit" => limit = value.parse().context("invalid limit")?, "before_ms" => before = value.parse().context("invalid before_ms")?, _ => bail!("unknown query field") }
                }
                ensure!((1..=100).contains(&limit) && before > 0, "invalid audit bounds");
                Ok(json!({"rows":control.store.rows(limit,before).await?}))
            }
            (Method::POST, "/v1/actions") => {
                let bytes = tokio::time::timeout(Duration::from_secs(5), to_bytes(request.into_body(), 4096)).await.context("body timeout")?.context("invalid request body")?;
                let action: Action = serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("invalid action JSON"))?;
                control.prepare(login, action).await
            }
            (Method::POST, p) if p.starts_with("/v1/actions/") && p.ends_with("/confirm") => {
                let id: i64 = p.trim_start_matches("/v1/actions/").trim_end_matches("/confirm").parse().context("invalid confirmation ID")?;
                let bytes = tokio::time::timeout(Duration::from_secs(5), to_bytes(request.into_body(), 4096)).await.context("body timeout")?.context("invalid request body")?;
                let confirmation: Confirmation = serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("invalid confirmation JSON"))?;
                control.confirm(login, id, confirmation.phrase).await
            }
            _ => bail!("unknown endpoint or method"),
        }
    }.await;
    match result {
        Ok(value) => {
            let status = match value["tracking_status"].as_str() {
                Some("FAILURE") => StatusCode::CONFLICT,
                Some("PENDING") => StatusCode::ACCEPTED,
                _ => StatusCode::OK,
            };
            (status, Json(value)).into_response()
        }
        Err(error) => {
            // Error strings are our bounded messages; never log request bodies or credentials.
            if control
                .audit("refuse", Some(login), None, &error.to_string(), None, false)
                .await
                .is_err()
            {
                return reply(StatusCode::INTERNAL_SERVER_ERROR, "audit unavailable");
            }
            reply(StatusCode::CONFLICT, &error.to_string())
        }
    }
}
