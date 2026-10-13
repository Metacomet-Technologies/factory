//! Read-only, bounded snapshot boundary. Never log snapshot contents or OS errors.
use crate::{AppState, now_ms};
use serde::Deserialize;
use shared::factory_api::{AgentBalance, AgentTool, Agents};
use std::{os::unix::fs::MetadataExt, path::Path, time::Duration};
use tokio::io::AsyncReadExt;

const STALE_MS: i64 = 45 * 60 * 1000;
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
}
fn valid(t: &AgentTool, now: i64) -> bool {
    t.note.is_none()
        && t.source.as_deref() == source(&t.tool)
        && t.reason.as_deref().is_none_or(|r| {
            matches!(
                r,
                "unknown, format changed"
                    | "CLI timed out"
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
        && t.balances.len() <= 2
        && t.balances.iter().all(valid_balance)
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
#[derive(Deserialize)]
struct Snapshot {
    schema_version: u8,
    generated_at_ms: i64,
    tools: Vec<AgentTool>,
}
fn parse(bytes: &[u8], now: i64) -> Option<Agents> {
    let snapshot: Snapshot = serde_json::from_slice(bytes).ok()?;
    if snapshot.schema_version != 1
        || snapshot.generated_at_ms <= 0
        || snapshot.generated_at_ms > now
        || snapshot.tools.len() != TOOLS.len()
    {
        return None;
    }
    let mut tools = snapshot.tools;
    for (tool, expected) in tools.iter_mut().zip(TOOLS) {
        if tool.tool != expected || !valid(tool, now) {
            return None;
        }
        if source(expected).is_some() && tool.observed_at_ms.is_some_and(|at| now - at > STALE_MS) {
            tool.status = "stale".into();
            tool.reason
                .get_or_insert_with(|| "last good reading older than 45 minutes".into());
        }
    }
    Some(Agents { tools })
}
pub(crate) async fn read(path: &Path) -> Agents {
    if !tokio::fs::metadata(path).await.is_ok_and(|m| m.is_file()) {
        return unavailable("usage snapshot unavailable");
    }
    let Ok(file) = tokio::fs::File::open(path).await else {
        return unavailable("usage snapshot unavailable");
    };
    let mut bytes = Vec::new();
    if file.take(100_001).read_to_end(&mut bytes).await.is_err() || bytes.len() > 100_000 {
        return unavailable("usage snapshot invalid");
    }
    parse(&bytes, now_ms()).unwrap_or_else(|| unavailable("usage snapshot invalid"))
}
impl AppState {
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
            tokio::fs::write(&state.usage_snapshot, serde_json::to_vec(&fixture(at))?).await?;
            let fresh = get().await?;
            assert_eq!(fresh["tools"][0]["status"], "ok");
            assert_eq!(fresh["tools"][0]["balance"]["remaining"], "171.27");
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
            let old = at - STALE_MS - 1;
            let next = state.usage_snapshot.with_extension("tmp");
            tokio::fs::write(&next, serde_json::to_vec(&fixture(old))?).await?;
            tokio::fs::rename(next, &state.usage_snapshot).await?;
            let stale = get().await?;
            assert_eq!(stale["tools"][0]["status"], "stale");
            assert_eq!(stale["tools"][0]["observed_at_ms"], old);
            let changed = event(&mut stream).await?;
            assert_eq!(changed["type"], "agents.usage");
            assert!(changed["ts_ms"].as_i64().unwrap() >= at);
            assert_eq!(changed["data"]["tools"][0]["status"], "stale");
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
