#!/usr/bin/env python3
"""Drive the sandbox speed endpoint through each mode; print evidence as JSON."""
import json
from pathlib import Path
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / ".sandbox"
PORT = json.loads((STATE / "ports.json").read_text())["factory-api"]
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
MODE = STATE / "network-speed"
MB = 1_000_000
# The ping shim's healthy wan RTT, in ms.
WAN_MS = 8.691
frames = []


def get(path):
    with OPENER.open(f"http://127.0.0.1:{PORT}{path}", timeout=10) as response:
        return json.load(response)


def listen():
    """Collect network.speedtest frames; the API sends a keepalive every 15 s."""
    with OPENER.open(f"http://127.0.0.1:{PORT}/v1/stream", timeout=60) as response:
        event = ""
        for raw in response:
            line = raw.decode().strip()
            if line.startswith("event:"):
                event = line.partition(":")[2].strip()
            if line.startswith("data:") and event == "network.speedtest":
                frames.append(json.loads(line.partition(":")[2])["data"])


def next_test(mode, seconds=300):
    """Set the mode, then wait for a test that started after the change to be stored."""
    MODE.write_text(mode + "\n")
    changed_ms = int(time.time() * 1000)
    deadline = time.monotonic() + seconds
    while True:
        network = get("/v1/network")
        latest = network["latest_speed_test"]
        if latest and latest["started_ms"] > changed_ms:
            assert not any(w.startswith("network speedtest") for w in network["warnings"]), network
            return latest
        assert time.monotonic() < deadline, f"no {mode} test after {changed_ms}: {latest}"
        time.sleep(2)


threading.Thread(target=listen, daemon=True).start()
evidence = {"tests": {}}
try:
    ok = next_test("ok")
    assert ok["outcome"] == "ok" and ok["error"] is None, ok
    assert (ok["download_bytes"], ok["upload_bytes"]) == (440 * MB, 290 * MB), ok
    assert ok["download_bps"] > 1e9 and ok["upload_bps"] > 1e9, ok
    assert ok["colo"] == "SBX", ok
    assert ok["idle_latency_ms"] == WAN_MS, ok
    assert ok["download_loaded_latency_ms"] == ok["upload_loaded_latency_ms"] == WAN_MS, ok

    slow = next_test("slow")
    assert slow["outcome"] == "ok", slow
    # Each direction stops after its first 10 MB step: 4 x 10 MB of 440 and 290 MB.
    assert (slow["download_bytes"], slow["upload_bytes"]) == (40 * MB, 40 * MB), slow
    for rate in (slow["download_bps"], slow["upload_bps"]):
        assert 40e6 < rate <= 51e6, slow

    fail = next_test("fail")
    assert fail["outcome"] == "failed", fail
    assert "500" in fail["error"] and fail["error"].startswith("download of 10000000 bytes"), fail
    assert fail["download_bps"] is None and fail["upload_bps"] is None, fail
    assert (fail["download_bytes"], fail["upload_bytes"]) == (0, 0), fail

    hang = next_test("hang")
    assert hang["outcome"] == "timeout" and hang["error"] is None, hang
    assert 60_000 <= hang["ended_ms"] - hang["started_ms"] < 62_000, hang
    assert hang["download_bps"] is None and hang["upload_bps"] is None, hang
    assert (hang["download_bytes"], hang["upload_bytes"]) == (0, 0), hang

    stored = {"ok": ok, "slow": slow, "fail": fail, "hang": hang}
    for name, row in stored.items():
        streamed = [f for f in frames if f["id"] == row["id"]]
        assert streamed == [row], (name, streamed, row)
        evidence["tests"][name] = row
    ids = [row["id"] for row in stored.values()]
    for query, range_ in [("", "7d"), ("?range=24h", "24h"), ("?range=365d", "365d")]:
        body = get(f"/v1/network/speed-tests{query}")
        assert body["range"] == range_, body
        listed = [t for t in body["tests"] if t["id"] in ids]
        assert listed == list(stored.values()), (query, listed)
        starts = [t["started_ms"] for t in body["tests"]]
        assert starts == sorted(starts), starts
        evidence[f"speed_tests{query or '_default'}"] = len(body["tests"])
    evidence["sse_frames"] = len(frames)
finally:
    MODE.write_text("ok\n")
print(json.dumps(evidence, indent=2))
