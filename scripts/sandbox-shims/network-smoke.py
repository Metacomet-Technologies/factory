#!/usr/bin/env python3
"""Drive the sandbox network fixtures through each scenario; print evidence as JSON."""
import json
from pathlib import Path
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / ".sandbox"
PORT = json.loads((STATE / "ports.json").read_text())["factory-api"]
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
HOSTS = "127.0.0.1 localhost\n127.0.0.1 probe.sandbox.test\n"
ROUTE = STATE / "network-route"
DEFAULT_ROUTE = ROUTE.read_text()
NO_DEFAULT_ROUTE = "".join(line for line in DEFAULT_ROUTE.splitlines(True) if line.split("\t")[1] != "00000000")
ICMP = ("gateway", "1.1.1.1", "8.8.8.8")
WAN = ("1.1.1.1", "8.8.8.8")
HEALTHY = {"gateway": (10, 405), "1.1.1.1": (10, 8691), "8.8.8.8": (10, 8691), "dns": (10, None), "tailnet": (10, None)}


def get(path):
    with OPENER.open(f"http://127.0.0.1:{PORT}{path}", timeout=10) as response:
        return json.load(response)


def fixtures(ping="healthy", dns=True, tailnet="up", route=DEFAULT_ROUTE):
    (STATE / "network-ping").write_text(ping + "\n")
    # write_text truncates in place, so the namespace's /etc/hosts bind sees it.
    (STATE / "network-hosts").write_text(HOSTS if dns else "127.0.0.1 localhost\n")
    (STATE / "network-tailnet").write_text(tailnet + "\n")
    ROUTE.write_text(route)
    time.sleep(1)  # fake-net polls its fixture every 0.5 s.


def next_tick(after_ms, targets, seconds=75):
    """Wait for a tick that started after the fixtures changed, for these targets."""
    deadline = time.monotonic() + seconds
    while True:
        network = get("/v1/network")
        latest = {t["target"]: t["latest"] for t in network["targets"]}
        if all(latest[t] and latest[t]["ts_ms"] > after_ms for t in targets):
            return network, latest
        assert time.monotonic() < deadline, f"no tick after {after_ms}: {network}"
        time.sleep(1)


def check(name, expected, **fixture):
    fixtures(**fixture)
    changed_ms = int(time.time() * 1000)
    network, latest = next_tick(changed_ms, expected)
    for target, (received, avg_us) in expected.items():
        sample = latest[target]
        assert sample["sent"] == 10 and sample["received"] == received, (name, target, sample)
        assert (sample["rtt"] is None) == (received == 0), (name, target, sample)
        if avg_us is not None:
            assert sample["rtt"]["avg_us"] == avg_us, (name, target, sample)
    return network, latest


evidence = {"scenarios": {}}
try:
    for name, expected, fixture in [
        ("healthy", HEALTHY, {}),
        ("loss", {**HEALTHY, "1.1.1.1": (7, 8702), "8.8.8.8": (7, 8702)}, {"ping": "loss"}),
        ("latency", {**HEALTHY, "1.1.1.1": (10, 251442), "8.8.8.8": (10, 251442)}, {"ping": "latency"}),
        ("wan-down", {**HEALTHY, "1.1.1.1": (0, None), "8.8.8.8": (0, None)}, {"ping": "wan-down"}),
        ("lan-down", {**HEALTHY, **{t: (0, None) for t in ICMP}}, {"ping": "lan-down"}),
        ("unreachable", {**HEALTHY, **{t: (0, None) for t in ICMP}}, {"ping": "unreachable"}),
        ("no-default-route", {**HEALTHY, "gateway": (0, None)}, {"route": NO_DEFAULT_ROUTE}),
        ("dns-failure", {**HEALTHY, "dns": (0, None)}, {"dns": False}),
        ("tailnet-down", {**HEALTHY, "tailnet": (0, None)}, {"tailnet": "down"}),
    ]:
        network, latest = check(name, expected, **fixture)
        assert network["warnings"] == [], (name, network["warnings"])
        if name == "healthy":
            assert latest["gateway"]["address"] == "192.168.4.1"
            assert latest["dns"]["address"] == "probe.sandbox.test"
            assert latest["tailnet"]["address"] == "127.0.0.1:2222"
        if name == "no-default-route":
            assert latest["gateway"]["address"] is None, latest["gateway"]
        evidence["scenarios"][name] = {"latest": latest, "warnings": network["warnings"]}
    # A broken probe is a warning and no sample, never a fake outage.
    fixtures(ping="broken")
    changed_ms = int(time.time() * 1000)
    network, latest = next_tick(changed_ms, ("dns", "tailnet"))
    assert all(latest[t]["ts_ms"] < changed_ms for t in ICMP), latest
    assert any(w.startswith("network: gateway probe failed: ping printed no summary") for w in network["warnings"]), network
    evidence["scenarios"]["ping-broken"] = {"latest": latest, "warnings": network["warnings"]}
    fixtures()
    next_tick(int(time.time() * 1000), HEALTHY)

    history = {}
    for query, resolution in [("?range=1h", "raw"), ("", "raw"), ("?range=7d", "hourly"), ("?range=30d", "hourly")]:
        body = get(f"/v1/network/history{query}")
        assert body["resolution"] == resolution, body
        series = {s["target"]: s["points"] for s in body["series"]}
        assert set(series) >= set(HEALTHY), body
        assert all(series[t] for t in HEALTHY), body
        history[query or "default"] = {"resolution": resolution, "points": {t: len(p) for t, p in series.items()}}
    raw = {s["target"]: s["points"] for s in get("/v1/network/history?range=1h")["series"]}
    wan_loss = {p["loss_percent"] for t in WAN for p in raw[t]}
    assert {0.0, 30.0, 100.0} <= wan_loss, wan_loss
    assert max(p["latency_ms"]["avg"] or 0 for p in raw["1.1.1.1"]) > 250, raw["1.1.1.1"]
    evidence["history"] = history
    evidence["history_1h_wan_loss_percent"] = sorted(wan_loss)

    with OPENER.open(f"http://127.0.0.1:{PORT}/v1/stream", timeout=45) as response:
        deadline = time.monotonic() + 45
        event = ""
        while time.monotonic() < deadline:
            line = response.readline().decode().strip()
            if line.startswith("event:"):
                event = line.partition(":")[2].strip()
            if line.startswith("data:") and event == "network.sample":
                frame = json.loads(line.partition(":")[2])
                assert [s["target"] for s in frame["data"]] == list(HEALTHY), frame
                evidence["sse"] = frame
                break
        else:
            raise AssertionError("No network.sample SSE event")
finally:
    fixtures()
print(json.dumps(evidence, indent=2))
