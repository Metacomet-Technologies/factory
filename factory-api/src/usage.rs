//! Bounded snapshot and refresh-trigger boundaries. Never log private file contents.
use crate::types::{AgentBalance, AgentTool, Agents};
use crate::{AppState, now_ms};
use serde::{Deserialize, Serialize};
use std::{os::unix::fs::MetadataExt, path::Path, time::Duration};
use tokio::io::AsyncReadExt;

pub(crate) const STALE_MS: i64 = 45 * 60 * 1000;
const TOOLS: [&str; 5] = ["amp", "cursor", "claude-code", "codex", "kimi"];
fn source(tool: &str) -> Option<&'static str> {
    match tool {
        "amp" => Some("amp-cli"),
        "claude-code" => Some("claude-usage"),
        "codex" => Some("codex-app-server"),
        _ => None,
    }
}
fn unavailable(reason: &str) -> Agents {
    Agents {
        tools: TOOLS
            .into_iter()
            .map(|tool| AgentTool {
                tool: tool.into(),
                status: if source(tool).is_some() {
                    "unknown"
                } else {
                    "not_tracked"
                }
                .into(),
                note: None,
                reason: source(tool).map(|_| reason.into()),
                observed_at_ms: None,
                source: source(tool).map(str::to_owned),
                cli_version: None,
                plan: None,
                windows: vec![],
                balance: None,
                balances: vec![],
                reset_credits_available: None,
            })
            .collect(),
    }
}
fn decimal(value: &str) -> bool {
    let mut parts = value.split('.');
    let whole = parts.next().unwrap_or("");
    !value.is_empty()
        && value.len() <= 32
        && !whole.is_empty()
        && (whole == "0" || !whole.starts_with('0'))
        && whole.bytes().all(|b| b.is_ascii_digit())
        && parts
            .next()
            .is_none_or(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && parts.next().is_none()
}
fn valid_balance(b: &AgentBalance) -> bool {
    matches!(b.unit.as_str(), "usd" | "orb_hours" | "codex_credits")
        && b.amount == b.remaining
        && decimal(&b.amount)
        && b.total.as_deref().is_none_or(decimal)
        && b.total
            .as_ref()
            .is_none_or(|t| b.amount.parse::<f64>().unwrap() <= t.parse::<f64>().unwrap())
        && b.label.as_deref().is_none_or(|label| {
            b.unit == "usd"
                && b.total.is_none()
                && label.strip_prefix("workspace ").is_some_and(|slug| {
                    (1..=63).contains(&slug.len())
                        && slug.as_bytes()[0].is_ascii_alphanumeric()
                        && slug
                            .bytes()
                            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                })
        })
}
fn valid(t: &AgentTool, now: i64) -> bool {
    t.note.is_none()
        && t.source.as_deref() == source(&t.tool)
        && t.reason.as_deref().is_none_or(|r| {
            matches!(
                r,
                "unknown, format changed"
                    | "CLI timed out"
                    | "format changed"
                    | "timeout"
                    | "CLI missing"
                    | "CLI failed"
                    | "CLI output too large"
                    | "last good reading older than 45 minutes"
            )
        })
        && t.observed_at_ms.is_none_or(|at| at > 0 && at <= now)
        && t.cli_version.as_deref().is_none_or(|v| {
            !v.is_empty()
                && v.len() <= 64
                && v.bytes()
                    .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'-' | b'g' | b'a'..=b'f'))
        })
        && t.plan.as_deref().is_none_or(|p| {
            matches!(
                p,
                "Gigawatt" | "free" | "plus" | "pro" | "team" | "business" | "enterprise" | "edu"
            )
        })
        && t.windows.len() <= 20
        && t.windows.iter().enumerate().all(|(i, w)| {
            matches!(
                w.name.as_str(),
                "agent"
                    | "orb"
                    | "weekly"
                    | "five_hour"
                    | "weekly_fable"
                    | "weekly_opus"
                    | "weekly_sonnet"
                    | "primary"
                    | "secondary"
            ) && t.windows[..i].iter().all(|prior| prior.name != w.name)
                && w.used_percent.is_finite()
                && (0.0..=100.0).contains(&w.used_percent)
                && w.resets_at_ms.is_none_or(|at| at > 0)
                && w.window_minutes.is_none_or(|minutes| minutes > 0)
        })
        && t.balances.len() <= if t.tool == "amp" { 8 } else { 2 }
        && t.balances.iter().filter(|b| b.label.is_none()).count() <= 2
        && t.balances.iter().enumerate().all(|(i, b)| {
            valid_balance(b)
                && b.label.as_ref().is_none_or(|label| {
                    t.tool == "amp"
                        && t.balances[..i]
                            .iter()
                            .all(|prior| prior.label.as_ref() != Some(label))
                })
        })
        && t.balance.as_ref() == t.balances.first()
        && match t.status.as_str() {
            "ok" => {
                source(&t.tool).is_some()
                    && t.observed_at_ms.is_some()
                    && t.cli_version.is_some()
                    && t.reason.is_none()
                    && !t.windows.is_empty()
            }
            "unknown" | "stale" => source(&t.tool).is_some() && t.reason.is_some(),
            "not_tracked" => {
                source(&t.tool).is_none()
                    && t.windows.is_empty()
                    && t.balances.is_empty()
                    && t.observed_at_ms.is_none()
            }
            _ => false,
        }
}
#[derive(Deserialize, Serialize)]
struct Snapshot {
    schema_version: u8,
    generated_at_ms: i64,
    tools: Vec<AgentTool>,
}
fn parse(bytes: &[u8], now: i64) -> Option<Snapshot> {
    let mut snapshot: Snapshot = serde_json::from_slice(bytes).ok()?;
    if snapshot.schema_version != 1
        || snapshot.generated_at_ms <= 0
        || snapshot.generated_at_ms > now
        || snapshot.tools.len() != TOOLS.len()
    {
        return None;
    }
    for (tool, expected) in snapshot.tools.iter_mut().zip(TOOLS) {
        if tool.tool != expected || !valid(tool, now) {
            return None;
        }
        if source(expected).is_some() && tool.observed_at_ms.is_some_and(|at| now - at > STALE_MS) {
            tool.status = "stale".into();
            tool.reason
                .get_or_insert_with(|| "last good reading older than 45 minutes".into());
        }
    }
    Some(snapshot)
}
async fn snapshot(path: &Path, now: i64) -> Result<Snapshot, &'static str> {
    if !tokio::fs::metadata(path).await.is_ok_and(|m| m.is_file()) {
        return Err("usage snapshot unavailable");
    }
    let Ok(file) = tokio::fs::File::open(path).await else {
        return Err("usage snapshot unavailable");
    };
    let mut bytes = Vec::new();
    if file.take(100_001).read_to_end(&mut bytes).await.is_err() || bytes.len() > 100_000 {
        return Err("usage snapshot invalid");
    }
    parse(&bytes, now).ok_or("usage snapshot invalid")
}
pub(crate) async fn read(path: &Path) -> Agents {
    match snapshot(path, now_ms()).await {
        Ok(snapshot) => Agents {
            tools: snapshot.tools,
        },
        Err(reason) => unavailable(reason),
    }
}
/// Last good reading per collected tool; None when the snapshot is unreadable or invalid.
pub(crate) async fn observations(path: &Path, now: i64) -> Option<Vec<(String, Option<i64>)>> {
    let snapshot = snapshot(path, now).await.ok()?;
    Some(
        snapshot
            .tools
            .into_iter()
            .filter(|tool| source(&tool.tool).is_some())
            .map(|tool| (tool.tool, tool.observed_at_ms))
            .collect(),
    )
}
impl AppState {
    /// The trigger itself records the accepted timestamp, including across restarts.
    /// Keep the lock and filesystem transaction in one blocking task so HTTP
    /// cancellation cannot release the lock while a rename is still in flight.
    pub(crate) async fn refresh_usage(&self) -> anyhow::Result<(bool, i64)> {
        let state = self.clone();
        tokio::task::spawn_blocking(move || {
            use std::io::{Read, Write};
            use std::os::unix::fs::OpenOptionsExt;
            let _guard = state
                .usage_refresh_lock
                .lock()
                .map_err(|_| anyhow::anyhow!("refresh lock unavailable"))?;
            let now = now_ms();
            let last = match std::fs::File::open(&state.usage_trigger) {
                Ok(file) => {
                    let mut text = String::new();
                    file.take(32).read_to_string(&mut text)?;
                    text.trim().parse::<i64>()?
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
                Err(e) => return Err(e.into()),
            };
            let mut bytes = Vec::new();
            let generated = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(&state.usage_snapshot)
                .ok()
                .filter(|file| file.metadata().is_ok_and(|m| m.is_file()))
                .and_then(|file| file.take(100_001).read_to_end(&mut bytes).ok())
                .filter(|_| bytes.len() <= 100_000)
                .and_then(|_| parse(&bytes, now))
                .map_or(0, |snapshot| snapshot.generated_at_ms);
            let next = last.max(generated).saturating_add(180_000);
            if now < next {
                return Ok((false, next));
            }
            let temporary = state.usage_trigger.with_extension("tmp");
            let result = (|| -> std::io::Result<()> {
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .mode(0o600)
                    .open(&temporary)?;
                writeln!(file, "{now}")?;
                file.sync_all()?;
                std::fs::rename(&temporary, &state.usage_trigger)
            })();
            if result.is_err() {
                let _ = std::fs::remove_file(temporary);
            }
            result?;
            Ok((true, now + 180_000))
        })
        .await?
    }

    pub(crate) fn start_usage_collector(&self) -> tokio::task::JoinHandle<()> {
        let state = self.clone();
        tokio::spawn(async move {
            let mut timer = tokio::time::interval(Duration::from_secs(30));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut previous = None;
            loop {
                tokio::select! { biased;
                    _ = state.shutdown.cancelled() => break,
                    _ = timer.tick() => (),
                }
                let stamp = tokio::fs::metadata(&state.usage_snapshot)
                    .await
                    .ok()
                    .map(|m| (m.mtime(), m.mtime_nsec(), m.ino(), m.len()));
                if previous.as_ref() != Some(&stamp) {
                    let agents = read(&state.usage_snapshot).await;
                    state.emit("agents.usage", agents);
                    previous = Some(stamp);
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn fixture(at: i64) -> Value {
        let mut tools = serde_json::to_value(unavailable("CLI failed")).unwrap()["tools"].clone();
        tools[0] = json!({
            "tool":"amp", "status":"ok", "note":null, "reason":null,
            "observed_at_ms":at, "source":"amp-cli", "cli_version":"0.0.1791763306-ged595a", "plan":"Gigawatt",
            "windows":[{"name":"agent","used_percent":14.0,"resets_at_ms":1794268800000_i64,"window_minutes":null}],
            "balance":{"amount":"171.27","remaining":"171.27","total":"200","unit":"usd"},
            "balances":[{"amount":"171.27","remaining":"171.27","total":"200","unit":"usd"},
                {"amount":"998.1","remaining":"998.1","total":"1000","unit":"orb_hours"}],
            "reset_credits_available":null
        });
        json!({"schema_version":1,"generated_at_ms":at,"tools":tools})
    }

    #[test]
    fn contract_and_stale_boundary() {
        let at = 1791800000000;
        let value = fixture(at);
        let bytes = serde_json::to_vec(&value).unwrap();
        let fresh = parse(&bytes, at + STALE_MS).unwrap();
        let serialized = serde_json::to_value(&fresh).unwrap();
        assert_eq!(serialized["tools"][0], value["tools"][0]);
        assert_eq!(serialized["tools"][0]["balances"][1]["unit"], "orb_hours");
        assert_eq!(serialized["tools"][0]["observed_at_ms"], at);
        let stale = parse(&bytes, at + STALE_MS + 1).unwrap();
        assert_eq!(stale.tools[0].status, "stale");
        assert_eq!(stale.tools[0].observed_at_ms, Some(at));
        assert_eq!(stale.tools[1].status, "not_tracked");
        for (field, bad) in [
            ("source", json!("private@email")),
            ("status", json!("new")),
            ("observed_at_ms", json!(at + 1)),
            ("reason", json!("private-token")),
        ] {
            let mut invalid = value.clone();
            invalid["tools"][0][field] = bad;
            assert!(parse(&serde_json::to_vec(&invalid).unwrap(), at).is_none());
        }
    }

    #[tokio::test]
    async fn http_refresh_cooldown_and_atomic_trigger() -> anyhow::Result<()> {
        tokio::time::timeout(Duration::from_secs(15), async {
            let dir = tempfile::tempdir()?;
            pricing::migrate(dir.path().join("pricing.db"))?;
            let mut state = AppState::new(
                "http://127.0.0.1:1".into(),
                dir.path().join("requests.db"),
                dir.path().join("pricing.db"),
                crate::fleet::Config { nodes: vec![] },
            )
            .await?;
            state.usage_snapshot = dir.path().join("usage.json");
            state.usage_trigger = dir.path().join("request");
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
            let url = format!("http://{}/v1/agents/refresh", listener.local_addr()?);
            let server =
                tokio::spawn(axum::serve(listener, crate::router(state.clone())).into_future());
            let client = reqwest::Client::new();
            // Neither malformed requests nor foreign browser submissions write a trigger.
            for (body, status) in [("x".into(), 400), ("x".repeat(1025), 413)] {
                assert_eq!(client.post(&url).body(body).send().await?.status(), status);
            }
            assert_eq!(
                client
                    .post(&url)
                    .header("sec-fetch-site", "cross-site")
                    .send()
                    .await?
                    .status(),
                403
            );
            assert_eq!(client.get(&url).send().await?.status(), 405);
            assert!(!state.usage_trigger.exists());
            let accepted = client.post(&url).send().await?;
            assert_eq!(accepted.status(), 202);
            let accepted: Value = accepted.json().await?;
            assert_eq!(accepted["status"], "accepted");
            let next = accepted["next_allowed_at_ms"].as_i64().unwrap();
            let contents = std::fs::read_to_string(&state.usage_trigger)?;
            assert_eq!(contents.trim().parse::<i64>()?, next - 180_000);
            let repeat = client.post(&url).send().await?;
            assert_eq!(repeat.status(), 429);
            assert_eq!(repeat.headers()["retry-after"], "180");
            let repeat: Value = repeat.json().await?;
            assert_eq!(repeat["error"]["code"], "cooldown");
            assert_eq!(repeat["next_allowed_at_ms"], next);
            assert_eq!(std::fs::read_to_string(&state.usage_trigger)?, contents);

            // An agent-owned snapshot may be replaced by a FIFO with no writer.
            // Both requests must finish promptly, without wedging the refresh lock.
            std::fs::remove_file(&state.usage_trigger)?;
            assert!(
                std::process::Command::new("mkfifo")
                    .arg(&state.usage_snapshot)
                    .status()?
                    .success()
            );
            for status in [202, 429] {
                let response =
                    tokio::time::timeout(Duration::from_secs(1), client.post(&url).send())
                        .await
                        .expect("FIFO snapshot must not block refresh")?;
                assert_eq!(response.status(), status);
            }
            std::fs::remove_file(&state.usage_snapshot)?;

            // A later timer snapshot wins over the persisted trigger. Fractional
            // seconds round up rather than letting clients retry too early.
            let generated = now_ms() - 60_200;
            std::fs::write(&state.usage_trigger, (generated - 20_000).to_string())?;
            std::fs::write(
                &state.usage_snapshot,
                serde_json::to_vec(&fixture(generated))?,
            )?;
            let repeat = client.post(&url).send().await?;
            assert_eq!(repeat.status(), 429);
            assert_eq!(repeat.headers()["retry-after"], "120");
            assert_eq!(
                repeat.json::<Value>().await?["next_allowed_at_ms"],
                generated + 180_000
            );

            // Expired snapshot cannot block refresh; replacement preserves an
            // already-open reader's complete old bytes (not truncate-in-place).
            std::fs::write(
                &state.usage_snapshot,
                serde_json::to_vec(&fixture(now_ms() - 180_001))?,
            )?;
            std::fs::write(&state.usage_trigger, "1\n")?;
            let old_inode = std::fs::File::open(&state.usage_trigger)?;
            let (one, two) = tokio::join!(client.post(&url).send(), client.post(&url).send());
            let mut statuses = [one?.status().as_u16(), two?.status().as_u16()];
            statuses.sort();
            assert_eq!(statuses, [202, 429]);
            assert_ne!(
                old_inode.metadata()?.ino(),
                std::fs::metadata(&state.usage_trigger)?.ino()
            );
            assert_eq!(std::io::read_to_string(old_inode)?, "1\n");
            assert!(!state.usage_trigger.with_extension("tmp").exists());

            // A new API instance must honor the accepted trigger after restart.
            server.abort();
            let mut restarted = state.clone();
            restarted.usage_refresh_lock = Default::default();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
            let url = format!("http://{}/v1/agents/refresh", listener.local_addr()?);
            let server =
                tokio::spawn(axum::serve(listener, crate::router(restarted)).into_future());
            assert_eq!(client.post(&url).send().await?.status(), 429);

            // Failed writes do not consume the cooldown; repair permits retry.
            std::fs::write(&state.usage_trigger, "1\n")?;
            std::fs::create_dir(state.usage_trigger.with_extension("tmp"))?;
            let failed = client.post(&url).send().await?;
            assert_eq!(failed.status(), 500);
            assert_eq!(
                failed.json::<Value>().await?["error"]["code"],
                "trigger_write_failed"
            );
            assert_eq!(std::fs::read_to_string(&state.usage_trigger)?, "1\n");
            std::fs::remove_dir(state.usage_trigger.with_extension("tmp"))?;
            assert_eq!(client.post(&url).send().await?.status(), 202);
            server.abort();
            state.db.close().await?;
            anyhow::Ok(())
        })
        .await??;
        Ok(())
    }

    #[tokio::test]
    async fn http_snapshots_and_sse_change() -> anyhow::Result<()> {
        tokio::time::timeout(Duration::from_secs(40), async {
            let dir = tempfile::tempdir()?;
            pricing::migrate(dir.path().join("pricing.db"))?;
            let mut state = AppState::new(
                "http://127.0.0.1:1".into(),
                dir.path().join("requests.db"),
                dir.path().join("pricing.db"),
                crate::fleet::Config { nodes: vec![] },
            )
            .await?;
            state.usage_snapshot = dir.path().join("usage.json");
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
            let address = listener.local_addr()?;
            let server_state = state.clone();
            let server =
                tokio::spawn(
                    async move { axum::serve(listener, crate::router(server_state)).await },
                );
            let client = reqwest::Client::new();
            let get = || async {
                client
                    .get(format!("http://{address}/v1/agents"))
                    .send()
                    .await?
                    .error_for_status()?
                    .json::<Value>()
                    .await
            };
            let missing = get().await?;
            assert_eq!(missing["tools"][0]["status"], "unknown");
            assert_eq!(missing["tools"][0]["reason"], "usage snapshot unavailable");
            tokio::fs::write(&state.usage_snapshot, "{private malformed JSON").await?;
            let invalid = get().await?;
            assert_eq!(invalid["tools"][0]["reason"], "usage snapshot invalid");
            assert!(!invalid.to_string().contains("private"));
            let at = now_ms();
            let mut sample = fixture(at);
            sample["tools"][0]["balances"].as_array_mut().unwrap().push(json!({
                "amount":"0", "remaining":"0", "total":null, "unit":"usd", "label":"workspace metacomet"
            }));
            tokio::fs::write(&state.usage_snapshot, serde_json::to_vec(&sample)?).await?;
            let fresh = get().await?;
            assert_eq!(fresh["tools"][0]["status"], "ok");
            assert_eq!(fresh["tools"][0]["balance"]["remaining"], "171.27");
            assert_eq!(fresh["tools"][0]["balances"], sample["tools"][0]["balances"]);
            for diagnostic in ["format changed", "timeout", "CLI missing"] {
                let mut failed = sample.clone();
                failed["tools"][0]["status"] = json!("unknown");
                failed["tools"][0]["reason"] = json!(diagnostic);
                tokio::fs::write(&state.usage_snapshot, serde_json::to_vec(&failed)?).await?;
                let unknown = get().await?;
                assert_eq!(unknown["tools"][0]["status"], "unknown");
                assert_eq!(unknown["tools"][0]["reason"], diagnostic);
                failed["tools"][0]["observed_at_ms"] = json!(at - STALE_MS - 1);
                tokio::fs::write(&state.usage_snapshot, serde_json::to_vec(&failed)?).await?;
                let stale = get().await?;
                assert_eq!(stale["tools"][0]["status"], "stale");
                assert_eq!(stale["tools"][0]["reason"], diagnostic);
            }
            for (field, bad) in [
                ("label", json!("workspace ")),
                ("label", json!("workspace -bad")),
                ("label", json!("workspace private@email")),
                ("label", json!("workspace bad\nlabel")),
                ("label", json!("workspace méta")),
                ("label", json!(format!("workspace {}", "a".repeat(64)))),
                ("label", Value::Null),
                ("unit", json!("orb_hours")),
                ("total", json!("200")),
            ] {
                let mut bad_sample = sample.clone();
                bad_sample["tools"][0]["balances"][2][field] = bad;
                tokio::fs::write(&state.usage_snapshot, serde_json::to_vec(&bad_sample)?).await?;
                let invalid = get().await?;
                assert_eq!(invalid["tools"][0]["reason"], "usage snapshot invalid");
                assert!(!invalid.to_string().contains("private"));
            }
            let mut bounded = sample.clone();
            for i in 0..5 {
                bounded["tools"][0]["balances"].as_array_mut().unwrap().push(json!({
                    "amount":"12.34", "remaining":"12.34", "total":null, "unit":"usd",
                    "label":format!("workspace {}{i}", "a".repeat(62))
                }));
            }
            tokio::fs::write(&state.usage_snapshot, serde_json::to_vec(&bounded)?).await?;
            assert_eq!(get().await?["tools"][0]["balances"], bounded["tools"][0]["balances"]);
            for extra in [sample["tools"][0]["balances"][2].clone(), json!({
                "amount":"1", "remaining":"1", "total":null, "unit":"usd", "label":"workspace overflow"
            })] {
                let mut overflow = bounded.clone();
                overflow["tools"][0]["balances"].as_array_mut().unwrap().push(extra);
                tokio::fs::write(&state.usage_snapshot, serde_json::to_vec(&overflow)?).await?;
                assert_eq!(get().await?["tools"][0]["reason"], "usage snapshot invalid");
            }
            let mut duplicate = sample.clone();
            duplicate["tools"][0]["balances"].as_array_mut().unwrap().push(sample["tools"][0]["balances"][2].clone());
            tokio::fs::write(&state.usage_snapshot, serde_json::to_vec(&duplicate)?).await?;
            assert_eq!(get().await?["tools"][0]["reason"], "usage snapshot invalid");
            let mut wrong_tool = sample.clone();
            wrong_tool["tools"][2]["balances"] = json!([sample["tools"][0]["balances"][2].clone()]);
            wrong_tool["tools"][2]["balance"] = sample["tools"][0]["balances"][2].clone();
            tokio::fs::write(&state.usage_snapshot, serde_json::to_vec(&wrong_tool)?).await?;
            assert_eq!(get().await?["tools"][0]["reason"], "usage snapshot invalid");
            tokio::fs::write(&state.usage_snapshot, serde_json::to_vec(&sample)?).await?;
            let mut stream = client
                .get(format!("http://{address}/v1/stream"))
                .send()
                .await?;
            let watcher = state.start_usage_collector();
            async fn event(stream: &mut reqwest::Response) -> anyhow::Result<Value> {
                let mut data = String::new();
                loop {
                    data.push_str(&String::from_utf8(stream.chunk().await?.unwrap().to_vec())?);
                    while let Some(end) = data.find("\n\n") {
                        let frame = data[..end].to_owned();
                        data.drain(..end + 2);
                        if frame.contains("event: agents.usage") {
                            let payload = frame
                                .lines()
                                .find_map(|l| l.strip_prefix("data: "))
                                .unwrap();
                            return Ok(serde_json::from_str(payload)?);
                        }
                    }
                }
            }
            let initial = event(&mut stream).await?;
            assert_eq!(initial["type"], "agents.usage");
            assert_eq!(initial["data"]["tools"][0]["status"], "ok");
            assert_eq!(initial["data"]["tools"][0]["balances"], sample["tools"][0]["balances"]);
            let old = at - STALE_MS - 1;
            let next = state.usage_snapshot.with_extension("tmp");
            sample["tools"][0]["status"] = json!("unknown");
            sample["tools"][0]["reason"] = json!("format changed");
            sample["tools"][0]["observed_at_ms"] = json!(old);
            tokio::fs::write(&next, serde_json::to_vec(&sample)?).await?;
            tokio::fs::rename(next, &state.usage_snapshot).await?;
            let stale = get().await?;
            assert_eq!(stale["tools"][0]["status"], "stale");
            assert_eq!(stale["tools"][0]["reason"], "format changed");
            assert_eq!(stale["tools"][0]["observed_at_ms"], old);
            let changed = event(&mut stream).await?;
            assert_eq!(changed["type"], "agents.usage");
            assert!(changed["ts_ms"].as_i64().unwrap() >= at);
            assert_eq!(changed["data"]["tools"][0]["status"], "stale");
            assert_eq!(changed["data"]["tools"][0]["reason"], "format changed");
            state.shutdown.cancel();
            watcher.await?;
            server.abort();
            state.db.close().await?;
            anyhow::Ok(())
        })
        .await??;
        Ok(())
    }
}
