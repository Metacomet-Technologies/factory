#!/usr/bin/env python3
"""factory-console watchdog for factory-gpu (MET-150). Python stdlib only.

factory-api evaluates every other alert, but it runs on factory-gpu and cannot
report that node going down. A systemd timer runs this once a minute: after
five consecutive failed health checks it posts "factory-gpu unreachable" to
Slack, and on the next success it posts a recovery threaded under that alert.
Recovery replies and resolved parent updates retry independently from persisted
outboxes. State survives runs in $FACTORY_WATCHDOG_STATE. The bot token comes from the
systemd credential `slack-bot-token`; without it the watchdog only logs. Never
print the token.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

DASHBOARD_URL = "https://factory-gpu.bearded-pompano.ts.net"
DEFAULTS = {
    "FACTORY_WATCHDOG_HEALTH_URL": DASHBOARD_URL + "/v1/health",
    "FACTORY_WATCHDOG_STATE": "/var/lib/factory-watchdog/state.json",
    "FACTORY_WATCHDOG_THRESHOLD": "5",
    "FACTORY_ALERTS_CHANNEL": "C0C9N9HCRG8",
    "FACTORY_ALERTS_SLACK_URL": "https://slack.com/api",
}
# Direct connections only: a proxy must not see the token or mask an outage.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def log(message):
    print(message, flush=True)


def setting(env, name):
    return env.get(name) or DEFAULTS[name]


def read_token(env):
    directory = env.get("CREDENTIALS_DIRECTORY")
    if not directory:
        return None
    try:
        token = (Path(directory) / "slack-bot-token").read_text().strip()
    except OSError:
        return None
    if not token or len(token) > 512 or any(c.isspace() or not c.isprintable() for c in token):
        return None
    return token


def clock_synchronized():
    """True/False from timedatectl; None when unknown (then failures still count)."""
    try:
        result = subprocess.run(["timedatectl", "show", "-p", "NTPSynchronized", "--value"],
                                capture_output=True, text=True, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return {"yes": True, "no": False}.get(result.stdout.strip())


def check_health(url):
    try:
        with OPENER.open(urllib.request.Request(url, headers={"Accept": "application/json"}),
                         timeout=10) as response:
            response.read(65536)
            return True, f"HTTP {response.status}"
    except urllib.error.HTTPError as error:
        error.close()
        return False, f"HTTP {error.code}"
    except Exception as error:  # noqa: BLE001 - any failure means unreachable.
        reason = getattr(error, "reason", error)
        return False, " ".join(str(reason).split())[:160] or type(error).__name__


def escape(value):
    return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def message(title, fields, now_ms, severity, suffix=""):
    colors = {"critical": "#ff6a4f", "warning": "#ffd447",
              "resolved": "#7ee081", "neutral": "#728894"}
    emojis = {"critical": ":rotating_light:", "warning": ":warning:",
              "resolved": ":white_check_mark:", "neutral": ":information_source:"}
    blocks = [{"type": "section", "text": {"type": "mrkdwn", "verbatim": True,
                                          "text": f"*{escape(title)}*"}}]
    if fields:
        blocks.append({"type": "section", "fields": [
            {"type": "mrkdwn", "verbatim": True, "text": f"*{escape(label)}*\n{escape(value)}"}
            for label, value in fields[:10]]})
    seconds = now_ms // 1000
    utc = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(seconds))
    context = (f"factory-gpu · watchdog · <!date^{seconds}^{{date_short_pretty}} {{time}}|{utc}>"
               f" · <{DASHBOARD_URL}/devices/factory-gpu|Open devices page>{escape(suffix)}")
    blocks.append({"type": "context", "elements": [
        {"type": "mrkdwn", "verbatim": True, "text": context}]})
    return {"text": f"{emojis[severity]} {escape(title)}",
            "attachments": [{"color": colors[severity], "blocks": blocks}],
            "unfurl_links": False, "unfurl_media": False}


def slack(env, token, method, body):
    """Return Slack's acknowledgement; callers persist it before another request."""
    request = urllib.request.Request(
        setting(env, "FACTORY_ALERTS_SLACK_URL").rstrip("/") + "/" + method,
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json; charset=utf-8"},
        method="POST")
    try:
        with OPENER.open(request, timeout=10) as response:
            reply = json.load(response)
    except urllib.error.HTTPError as error:
        error.close()
        raise RuntimeError(f"Slack HTTP {error.code}") from None
    except (OSError, ValueError) as error:
        raise RuntimeError(f"Slack request failed: {type(error).__name__}") from None
    if reply.get("ok") is not True or not isinstance(reply.get("ts"), str):
        raise RuntimeError(f"Slack error: {reply.get('error', 'unknown error')}")
    return reply


def load_state(path):
    try:
        state = json.loads(path.read_text())
        if isinstance(state, dict) and isinstance(state.get("failures"), int):
            return state
        log(f"Ignoring malformed state in {path}")
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as error:
        log(f"Ignoring unreadable state in {path}: {type(error).__name__}")
    return {"failures": 0, "open": None}


def save_state(path, state):
    with tempfile.NamedTemporaryFile("w", dir=path.parent, prefix=".state.", delete=False) as out:
        json.dump(state, out, indent=2)
        out.write("\n")
        out.flush()
        os.fsync(out.fileno())
        temporary = out.name
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def minutes(ms):
    return f"{max(ms, 0) // 60000} min"


def retry_ready(item, now_ms):
    return now_ms >= item.get("next_attempt_ms", 0)


def failed(item, now_ms):
    item["attempts"] = item.get("attempts", 0) + 1
    item["next_attempt_ms"] = now_ms + min(30_000 * 2 ** min(item["attempts"] - 1, 5), 900_000)


def deliver_outbox(env, token, state, path, now_ms):
    if token is None:
        return
    for key, method in [("replies", "chat.postMessage"), ("updates", "chat.update")]:
        for item in list(state.get(key, [])):
            if item.get("attempts", 0) >= 12 or not retry_ready(item, now_ms):
                continue
            try:
                slack(env, token, method, item["body"])
                state[key].remove(item)
            except RuntimeError as error:
                failed(item, now_ms)
                log(f"Slack {key} failed (attempt {item['attempts']}/12): {error}")
            save_state(path, state)


def run(env=None, now_ms=None, clock=clock_synchronized):
    env = os.environ if env is None else env
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    path = Path(setting(env, "FACTORY_WATCHDOG_STATE"))
    threshold = int(setting(env, "FACTORY_WATCHDOG_THRESHOLD"))
    url = setting(env, "FACTORY_WATCHDOG_HEALTH_URL")
    token = read_token(env)
    state = load_state(path)
    ok, detail = check_health(url)
    opened = state.get("open")
    if opened:
        # Older state stored neither the channel nor the opening field snapshot.
        opened.setdefault("channel", setting(env, "FACTORY_ALERTS_CHANNEL"))
        opened.setdefault("fields", [("Failed checks", str(state["failures"])),
                                     ("Checking node", "factory-console"),
                                     ("Detail", opened["detail"])])
    if ok:
        if state["failures"]:
            log(f"factory-gpu reachable again after {state['failures']} failed checks ({detail})")
        state["failures"] = 0
        if opened:
            if not opened.get("ts"):
                log("Alert cleared; it was never posted, so no recovery is posted")
            else:
                duration = minutes(now_ms - opened["opened_at_ms"])
                reply = message(f"Resolved after {duration}: factory-gpu unreachable",
                                [("Checking node", "factory-console"), ("Detail", detail)],
                                now_ms, "resolved")
                reply.update(channel=opened["channel"], thread_ts=opened["ts"])
                update = message("Resolved: factory-gpu unreachable", opened["fields"],
                                 opened["opened_at_ms"], "resolved",
                                 f" · resolved after {duration}")
                update.update(channel=opened["channel"], ts=opened["ts"])
                state.setdefault("replies", []).append({"body": reply})
                state.setdefault("updates", []).append({"body": update})
            state["open"] = None
    elif clock() is False:
        # TLS fails when this node's own clock is wrong at boot (MET-99): not factory-gpu's fault.
        log(f"Health check failed ({detail}) but the local clock is unsynchronized; not counted")
    else:
        state["failures"] += 1
        log(f"Health check failed ({state['failures']}/{threshold}): {detail}")
        if state["failures"] >= threshold and not opened:
            opened = state["open"] = {
                "opened_at_ms": now_ms, "ts": None, "detail": detail,
                "channel": setting(env, "FACTORY_ALERTS_CHANNEL"),
                "fields": [("Failed checks", str(state["failures"])),
                           ("Checking node", "factory-console"), ("Detail", detail)]}
        if opened and not opened.get("ts") and retry_ready(opened, now_ms):
            if token is None:
                log("No Slack token; alert not posted")
            else:
                body = message("factory-gpu unreachable", opened["fields"],
                               opened["opened_at_ms"], "critical")
                body["channel"] = opened["channel"]
                save_state(path, state)
                try:
                    result = slack(env, token, "chat.postMessage", body)
                    opened["ts"] = result["ts"]
                    opened["channel"] = result.get("channel", opened["channel"])
                    save_state(path, state)
                    log("Posted unreachable alert")
                except RuntimeError as error:
                    failed(opened, now_ms)
                    log(f"Alert post failed; will retry next run: {error}")
    save_state(path, state)
    deliver_outbox(env, token, state, path, now_ms)
    return 0


def test_alert(env=None):
    env = os.environ if env is None else env
    token = read_token(env)
    if token is None:
        log("No Slack token in $CREDENTIALS_DIRECTORY/slack-bot-token")
        return 1
    now_ms = int(time.time() * 1000)
    title = "factory-watchdog alert test"
    fields = [("Checking node", "factory-console"), ("Detail", "No action needed")]
    body = message(title, fields, now_ms, "neutral")
    body["channel"] = setting(env, "FACTORY_ALERTS_CHANNEL")
    result = slack(env, token, "chat.postMessage", body)
    channel = result.get("channel", body["channel"])
    reply = message(f"Resolved after 0 min: {title}", [("Detail", "Test completed")],
                    now_ms, "resolved")
    reply.update(channel=channel, thread_ts=result["ts"])
    slack(env, token, "chat.postMessage", reply)
    update = message(f"Resolved: {title}", fields, now_ms, "resolved", " · resolved after 0 min")
    update.update(channel=channel, ts=result["ts"])
    slack(env, token, "chat.update", update)
    log(f"Posted test alert ts={result['ts']} with a threaded reply and parent update")
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--test-alert"]:
        sys.exit(test_alert())
    if sys.argv[1:]:
        sys.exit("Usage: factory-watchdog.py [--test-alert]")
    sys.exit(run())
