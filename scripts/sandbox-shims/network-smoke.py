#!/usr/bin/env python3
"""Drive the sandbox network fixtures through each scenario; print evidence as JSON."""
import json
from pathlib import Path
import time
import urllib.error
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
LINK_HEALTHY = {"state": "healthy"}
START_MS = int(time.time() * 1000)


def down(layer):
    return {"state": "down", "layer": layer}


def degraded(layer, reason):
    return {"state": "degraded", "layer": layer, "reason": reason}


def get(path):
    with OPENER.open(f"http://127.0.0.1:{PORT}{path}", timeout=10) as response:
        return json.load(response)


def get_error(path):
    try:
        body = get(path)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)
    raise AssertionError((path, body))


def walk_events(limit):
    """Every episode, newest first, paged with before=next_before."""
    pages, path = [], f"/v1/network/events?limit={limit}"
    while True:
        page = get(path)
        pages.append([(e["started_ms"], e["id"]) for e in page["events"]])
        if page["next_before"] is None:
            return pages
        assert page["next_before"] == page["events"][-1]["id"], page
        path = f"/v1/network/events?limit={limit}&before={page['next_before']}"


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


def second_tick(name, state, latest, targets):
    """Diagnosis needs two ticks for down; the state comes from the stored open event."""
    network, latest = next_tick(max(latest[t]["ts_ms"] for t in targets), targets)
    assert network["state"] == state, (name, network["state"], state)
    events = get("/v1/network/events?limit=50")["events"]
    # Episodes since this run began chain: each ends as changed exactly when the next starts then.
    chain = sorted((e for e in events if e["started_ms"] >= START_MS), key=lambda e: (e["started_ms"], e["id"]))
    for older, newer in zip(chain, chain[1:]):
        assert older["ended_ms"] is not None and older["ended_ms"] <= newer["started_ms"], (name, older, newer)
        reason = "changed" if older["ended_ms"] == newer["started_ms"] else "recovered"
        assert older["end_reason"] == reason, (name, older, newer)
    open_rows = [e for e in events if e["ended_ms"] is None]
    if state == LINK_HEALTHY:
        assert network["open_event"] is None and open_rows == [], (name, network["open_event"], open_rows)
        assert not chain or chain[-1]["end_reason"] == "recovered", (name, chain[-1])
    else:
        assert open_rows == [events[0]] and network["open_event"] == events[0], (name, events[0], network)
        assert {k: events[0].get(k) for k in state} == state and ("reason" in events[0]) == ("reason" in state), (name, events[0])
    return network, latest, events


def alert(key, active, seconds):
    """Wait for the engine (30 s source reads, 10 s ticks) to open or clear a key."""
    deadline = time.monotonic() + seconds
    while True:
        alerts = get("/v1/alerts")
        found = [a for a in alerts["active"] if a["key"] == key]
        if bool(found) == active:
            return found[0] if active else next(a for a in alerts["recent"] if a["key"] == key)
        assert time.monotonic() < deadline, f"{key} active={active} not reached: {alerts}"
        time.sleep(5)


evidence = {"scenarios": {}, "alerts": {}}
try:
    lan_episode = None
    for name, expected, fixture, state in [
        ("healthy", HEALTHY, {}, LINK_HEALTHY),
        ("loss", {**HEALTHY, "1.1.1.1": (7, 8702), "8.8.8.8": (7, 8702)}, {"ping": "loss"}, degraded("wan", "loss")),
        ("latency", {**HEALTHY, "1.1.1.1": (10, 251442), "8.8.8.8": (10, 251442)}, {"ping": "latency"},
         degraded("wan", "latency")),
        ("wan-down", {**HEALTHY, "1.1.1.1": (0, None), "8.8.8.8": (0, None)}, {"ping": "wan-down"}, down("wan")),
        ("recovered", HEALTHY, {}, LINK_HEALTHY),
        ("lan-down", {**HEALTHY, **{t: (0, None) for t in ICMP}}, {"ping": "lan-down"}, down("lan")),
        ("unreachable", {**HEALTHY, **{t: (0, None) for t in ICMP}}, {"ping": "unreachable"}, down("lan")),
        ("no-default-route", {**HEALTHY, "gateway": (0, None)}, {"route": NO_DEFAULT_ROUTE}, down("lan")),
        ("dns-failure", {**HEALTHY, "dns": (0, None)}, {"dns": False}, down("dns")),
        ("tailnet-down", {**HEALTHY, "tailnet": (0, None)}, {"tailnet": "down"}, down("tailnet")),
    ]:
        network, latest = check(name, expected, **fixture)
        assert network["warnings"] == [], (name, network["warnings"])
        if name == "healthy":
            assert latest["gateway"]["address"] == "192.168.4.1"
            assert latest["dns"]["address"] == "probe.sandbox.test"
            assert latest["tailnet"]["address"] == "127.0.0.1:2222"
        if name == "no-default-route":
            assert latest["gateway"]["address"] is None, latest["gateway"]
        network, latest, events = second_tick(name, state, latest, expected)
        event = network["open_event"]
        if name == "loss":
            assert (event["peak_loss_percent"], event["peak_rtt_us"]) == (30.0, 8702), event
        if name == "latency":
            assert (event["peak_loss_percent"], event["peak_rtt_us"]) == (0.0, 251442), event
        if state["state"] == "down":
            assert (event["peak_loss_percent"], event["peak_rtt_us"]) == (100.0, None), event
        # The same down state keeps one open lan episode across its three fixtures.
        if state == down("lan"):
            lan_episode = lan_episode or event["id"]
            assert event["id"] == lan_episode, (name, event, lan_episode)
        if name == "wan-down":
            # Open 2 min or more before the alert; recovery below clears it.
            opened = alert("network:wan_down", True, 240)
            assert opened["severity"] == "critical" and opened["summary"].startswith("network wan down for"), opened
            assert opened["opened_at_ms"] - event["started_ms"] >= 120_000, (opened, event)
            evidence["alerts"]["wan_down"] = {"event": event, "alert": opened}
        if name == "recovered":
            wan = next(e for e in events if e["id"] == evidence["alerts"]["wan_down"]["event"]["id"])
            assert wan["end_reason"] == "recovered", wan
            cleared = alert("network:wan_down", False, 90)
            assert cleared["cleared_at_ms"] >= wan["ended_ms"], (cleared, wan)
            evidence["alerts"]["wan_down"].update(closed=wan, cleared=cleared)
        if name == "no-default-route":
            opened = alert("network:lan_down", True, 240)
            assert opened["summary"].startswith("network lan down for"), opened
            evidence["alerts"]["lan_down"] = {"event": event, "alert": opened}
        if name == "dns-failure":
            evidence["alerts"]["lan_down"]["cleared"] = alert("network:lan_down", False, 90)
        evidence["scenarios"][name] = {"latest": latest, "warnings": network["warnings"],
                                       "state": network["state"], "open_event": event}
    # A broken probe is a warning and no sample, never a fake outage: the
    # unknown icmp layers name no fault.
    fixtures(ping="broken")
    changed_ms = int(time.time() * 1000)
    network, latest = next_tick(changed_ms, ("dns", "tailnet"))
    network, latest, events = second_tick("ping-broken", LINK_HEALTHY, latest, ("dns", "tailnet"))
    assert all(latest[t]["ts_ms"] < changed_ms for t in ICMP), latest
    assert any(w.startswith("network: gateway probe failed: ping printed no summary") for w in network["warnings"]), network
    evidence["scenarios"]["ping-broken"] = {"latest": latest, "warnings": network["warnings"], "state": network["state"]}
    evidence["events"] = [e for e in events if e["started_ms"] >= START_MS]
    fixtures()
    next_tick(int(time.time() * 1000), HEALTHY)

    pages = walk_events(2)
    keys = [key for page in pages for key in page]
    assert [key for page in walk_events(200) for key in page] == keys, pages
    assert len(pages) >= 2 and keys == sorted(set(keys), reverse=True), pages
    unknown = max(i for _, i in keys) + 1
    status, body = get_error(f"/v1/network/events?before={unknown}")
    assert status == 400 and body["error"]["code"] == "invalid_query", (status, body)
    evidence["paging"] = {"limit_2_pages": pages, "unknown_before": {"before": unknown, "status": status, "body": body}}

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
