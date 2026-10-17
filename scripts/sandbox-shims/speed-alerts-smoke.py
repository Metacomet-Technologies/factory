#!/usr/bin/env python3
"""Drive the speed-test alerts through failing, slow and recovered tests; print evidence as JSON."""
import json
from pathlib import Path
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / ".sandbox"
PORT = json.loads((STATE / "ports.json").read_text())["factory-api"]
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
MODE = STATE / "network-speed"
FAILING = "network:speedtest_failing"
LOW = "network:throughput_low"


def get(path):
    with OPENER.open(f"http://127.0.0.1:{PORT}{path}", timeout=10) as response:
        return json.load(response)


def tests_after(changed_ms, count, seconds):
    """Tests run every 120 s in the sandbox; wait for `count` that started after the change."""
    deadline = time.monotonic() + seconds
    while True:
        tests = [t for t in get("/v1/network/speed-tests?range=24h")["tests"] if t["started_ms"] > changed_ms]
        if len(tests) >= count:
            return tests[:count]
        assert time.monotonic() < deadline, f"{len(tests)} of {count} tests after {changed_ms}"
        time.sleep(5)


def active():
    return {a["key"]: a for a in get("/v1/alerts")["active"]}


def alert(key, is_active, seconds=90):
    """The engine reads its sources every 30 s and ticks every 10 s."""
    deadline = time.monotonic() + seconds
    while True:
        alerts = get("/v1/alerts")
        found = [a for a in alerts["active"] if a["key"] == key]
        if bool(found) == is_active:
            return found[0] if is_active else next(a for a in alerts["recent"] if a["key"] == key)
        assert time.monotonic() < deadline, f"{key} active={is_active} not reached: {alerts}"
        time.sleep(5)


def mode(name):
    MODE.write_text(name + "\n")
    return int(time.time() * 1000)


evidence = {}
try:
    # Earlier failed or slow tests count toward both streaks, so start after a fast ok test.
    fast = tests_after(mode("ok"), 1, 180)
    assert fast[0]["outcome"] == "ok" and min(fast[0]["download_bps"], fast[0]["upload_bps"]) >= 500e6, fast
    deadline = time.monotonic() + 90
    while FAILING in active() or LOW in active():
        assert time.monotonic() < deadline, active()
        time.sleep(5)
    changed = mode("fail")
    failed = tests_after(changed, 2, 300)
    assert all(t["outcome"] == "failed" for t in failed), failed
    assert FAILING not in active(), "two failures are not enough"
    failed = tests_after(changed, 3, 180)
    assert all(t["outcome"] == "failed" for t in failed), failed
    opened = alert(FAILING, True)
    assert opened["severity"] == "warning" and "HTTP status server error (500" in opened["summary"], opened
    evidence["speedtest_failing"] = {"tests": failed, "alert": opened}

    changed = mode("slow")
    slow = tests_after(changed, 1, 180)
    assert slow[0]["outcome"] == "ok" and slow[0]["download_bps"] < 500e6, slow
    evidence["speedtest_failing"]["cleared"] = alert(FAILING, False)
    assert LOW not in active(), "one slow test is not enough"
    slow = tests_after(changed, 3, 300)
    assert all(t["outcome"] == "ok" and min(t["download_bps"], t["upload_bps"]) < 500e6 for t in slow), slow
    opened = alert(LOW, True)
    assert opened["severity"] == "warning" and opened["summary"].startswith("network throughput below 500 Mb/s"), opened
    evidence["throughput_low"] = {"tests": slow, "alert": opened}

    changed = mode("ok")
    fast = tests_after(changed, 1, 180)
    assert fast[0]["outcome"] == "ok" and min(fast[0]["download_bps"], fast[0]["upload_bps"]) >= 500e6, fast
    evidence["throughput_low"]["cleared"] = alert(LOW, False)
finally:
    mode("ok")
print(json.dumps(evidence, indent=2))
