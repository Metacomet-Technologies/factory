#!/usr/bin/env python3
"""factory-console watchdog for factory-gpu (MET-150). Python stdlib only.

factory-api evaluates every other alert, but it runs on factory-gpu and cannot
report that node going down. A systemd timer runs this once a minute: after
five consecutive failed health checks it posts "factory-gpu unreachable" to
Slack, and on the next success it posts a recovery threaded under that alert.
State survives runs in $FACTORY_WATCHDOG_STATE. The bot token comes from the
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
        return False, f"HTTP {error.code}"
    except Exception as error:  # noqa: BLE001 - any failure means unreachable.
        reason = getattr(error, "reason", error)
        return False, " ".join(str(reason).split())[:160] or type(error).__name__


def post(env, token, text, thread_ts=None):
    """chat.postMessage; returns the message ts or raises."""
    body = {"channel": setting(env, "FACTORY_ALERTS_CHANNEL"), "text": text}
    if thread_ts:
        body["thread_ts"] = thread_ts
    request = urllib.request.Request(
        setting(env, "FACTORY_ALERTS_SLACK_URL").rstrip("/") + "/chat.postMessage",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json; charset=utf-8"},
        method="POST")
    try:
        with OPENER.open(request, timeout=10) as response:
            reply = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Slack HTTP {error.code}") from None
    except (OSError, ValueError) as error:
        raise RuntimeError(f"Slack request failed: {type(error).__name__}") from None
    if reply.get("ok") is not True or not isinstance(reply.get("ts"), str):
        raise RuntimeError(f"Slack error: {reply.get('error', 'unknown error')}")
    return reply["ts"]


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
    if ok:
        if state["failures"]:
            log(f"factory-gpu reachable again after {state['failures']} failed checks ({detail})")
        state["failures"] = 0
        if opened:
            text = (f":white_check_mark: Recovered after {minutes(now_ms - opened['opened_at_ms'])}: "
                    f"factory-gpu reachable again from factory-console · {DASHBOARD_URL}")
            if not opened.get("ts"):
                log("Alert cleared; it was never posted, so no recovery is posted")
                state["open"] = None
            elif token is None:
                log(f"No Slack token; recovery not posted: {text}")
                state["open"] = None
            else:
                try:
                    post(env, token, text, opened["ts"])
                    log("Posted recovery")
                    state["open"] = None
                except RuntimeError as error:
                    log(f"Recovery post failed; will retry next run: {error}")
    elif clock() is False:
        # TLS fails when this node's own clock is wrong at boot (MET-99): not factory-gpu's fault.
        log(f"Health check failed ({detail}) but the local clock is unsynchronized; not counted")
    else:
        state["failures"] += 1
        log(f"Health check failed ({state['failures']}/{threshold}): {detail}")
        if state["failures"] >= threshold and not opened:
            opened = state["open"] = {"opened_at_ms": now_ms, "ts": None, "detail": detail}
        if opened and not opened.get("ts"):
            text = (f":rotating_light: factory-gpu unreachable: {state['failures']} consecutive "
                    f"health checks failed from factory-console ({opened['detail']}) · {DASHBOARD_URL}")
            if token is None:
                log(f"No Slack token; alert not posted: {text}")
            else:
                try:
                    opened["ts"] = post(env, token, text)
                    log("Posted unreachable alert")
                except RuntimeError as error:
                    log(f"Alert post failed; will retry next run: {error}")
    save_state(path, state)
    return 0


def test_alert(env=None):
    env = os.environ if env is None else env
    token = read_token(env)
    if token is None:
        log("No Slack token in $CREDENTIALS_DIRECTORY/slack-bot-token")
        return 1
    ts = post(env, token, f":information_source: factory-watchdog alert test from factory-console "
                          f"(no action needed) · {DASHBOARD_URL}")
    post(env, token, f":white_check_mark: factory-watchdog alert test reply · {DASHBOARD_URL}", ts)
    log(f"Posted test alert ts={ts} with a threaded reply")
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--test-alert"]:
        sys.exit(test_alert())
    if sys.argv[1:]:
        sys.exit("Usage: factory-watchdog.py [--test-alert]")
    sys.exit(run())
