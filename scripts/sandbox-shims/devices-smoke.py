#!/usr/bin/env python3
"""Remote device ingest against this worktree's sandbox (docs/devices.md, "Sandbox").

Checks the fake Serve "/" mount forwards Authorization and strips identity headers,
both devices appear, factory-gpu stays fresh, SSE refetch, retries leave no duplicate
history rows, stopping the client makes it stale, a restart makes it unknown, and
the client recovers. Evidence goes to .sandbox/devices-check.json. Synthetic only.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import threading
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / ".sandbox"
spec = importlib.util.spec_from_file_location("agent", Path(__file__).with_name("fake-device-agent.py"))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


def get(path):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(f"http://127.0.0.1:{agent.ports()['factory-api']}{path}", timeout=5) as response:
        return json.load(response)


def until(what, timeout, probe):
    deadline = time.monotonic() + timeout
    while True:
        value = probe()
        if value:
            return value
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {what}")
        time.sleep(1)


def rows():
    with sqlite3.connect((STATE / "requests.db").as_uri() + "?mode=ro", uri=True) as db:
        return dict(db.execute("SELECT device_id, COUNT(*) FROM device_samples GROUP BY device_id").fetchall()), \
            db.execute("SELECT COUNT(*) - COUNT(DISTINCT ts_ms) FROM device_samples WHERE device_id='factory-console'").fetchone()[0]


def forwarded():
    return json.loads((STATE / "serve-forwarded.jsonl").read_text().splitlines()[-1])


def events(stop, found):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(f"http://127.0.0.1:{agent.ports()['factory-api']}/v1/stream", timeout=60) as stream:
        event = None
        for line in stream:
            if stop.is_set():
                return
            line = line.decode().strip()
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: ") and event == "devices.sample":
                data = json.loads(line[6:])["data"]
                if data and data["device"]["device_id"] == "factory-console":
                    found.append({"seq": data["ingest"]["seq"], "generated_at_ms": data["generated_at_ms"]})


def client(interval):
    return subprocess.Popen(["python3", Path(__file__).with_name("fake-device-agent.py"), "--interval", str(interval)],
                            stdout=(STATE / "fake-device-agent.log").open("ab"), stderr=subprocess.STDOUT)


def view(device="factory-console"):
    return get(f"/v1/devices/{device}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--interval", type=float, default=5.0)
    parser.add_argument("--no-restart", action="store_true", help="skip the sandbox down/up step")
    parser.add_argument("--kiosk", action="store_true", help="pass --kiosk when restarting the sandbox")
    args = parser.parse_args()
    token = agent.token()
    evidence = {}
    now = int(time.time() * 1000)
    probe = agent.build("complete", str(uuid.uuid4()), 1, now)

    # 1. Serve "/" mount: Authorization reaches factory-api; identity headers never do.
    status, body, headers = agent.post(probe)
    assert status == 401 and headers.get("WWW-Authenticate") == "Bearer", (status, body)
    status, body, _ = agent.post(probe, headers={"Tailscale-User-Login": "DGarbs51@github",
                                                 "Tailscale-App-Capabilities": "{}"})
    spoof = forwarded()
    assert status == 401 and "Tailscale-User-Login" in spoof["stripped"] and \
        not any(name.lower().startswith("tailscale-") for name in spoof["forwarded"]), spoof
    status, body, _ = agent.post(probe, device="factory-gpu", credential=token, raw=json.dumps({**probe, "device_id": "factory-gpu"}).encode())
    assert status == 403 and body["error"]["code"] == "forbidden_device", body
    status, body, _ = agent.post(probe, credential=token)
    accepted = forwarded()
    assert status == 200 and body["result"] == "stored", body
    assert "Authorization" in accepted["forwarded"], accepted
    evidence["serve"] = {"no_token": 401, "spoofed_identity": 401, "factory_gpu": 403, "token": status,
                         "forwarded_headers": accepted["forwarded"], "stripped_headers": spoof["stripped"]}

    # 2. Live client: both devices, factory-gpu unchanged, SSE refetch matches.
    gpu_before = view("factory-gpu")
    stop, found = threading.Event(), []
    threading.Thread(target=events, args=(stop, found), daemon=True).start()
    time.sleep(1)
    process = client(args.interval)
    until("two console events", 4 * args.interval + 10, lambda: len(found) >= 2)
    listed = get("/v1/devices")
    ids = [device["device_id"] for device in listed["devices"]]
    assert ids[:2] == ["factory-gpu", "factory-console"], ids
    console = view()
    assert console["device"]["health"]["status"] not in ("unknown", "stale"), console["device"]["health"]
    assert console["ingest"]["seq"] >= found[-1]["seq"], (console["ingest"], found)
    gpu = view("factory-gpu")
    assert gpu["ingest"] is None and gpu["device"]["collector"]["fast_ok"], gpu["device"]["collector"]
    assert gpu["device"]["observed_at_ms"] >= gpu_before["device"]["observed_at_ms"]
    assert gpu["generated_at_ms"] - gpu["device"]["observed_at_ms"] <= 30_000
    evidence["live"] = {"devices": listed["devices"], "sse_events": found[-3:], "refetched_seq": console["ingest"]["seq"],
                        "console_health": console["device"]["health"], "gpu_health": gpu["device"]["health"]["status"]}

    # 3. Stop the client; retries of one sample leave one history row.
    process.terminate()
    process.wait(timeout=10)
    time.sleep(1)
    before, _ = rows()
    retry = agent.build("unsupported", str(uuid.uuid4()), 1, int(time.time() * 1000))
    results = [agent.post(retry, credential=token)[1] for _ in range(3)]
    after, duplicates = rows()
    assert [r["result"] for r in results] == ["stored", "ignored", "ignored"], results
    assert [r["reason"] for r in results[1:]] == ["duplicate", "duplicate"], results
    assert after["factory-console"] == before["factory-console"] + 1 and duplicates == 0, (before, after)
    evidence["retries"] = {"results": [(r["result"], r["reason"], r["history_written"]) for r in results],
                           "rows_before": before, "rows_after": after, "duplicate_rows": duplicates}

    # 4. Quiet for 45 s: stale, with the transport reason.
    stale = until("stale console", 70, lambda: (v := view())["device"]["health"]["status"] == "stale" and v)
    assert any(r["metric"] == "ingest.transport" for r in stale["device"]["health"]["reasons"])
    assert stale["device"]["cpu"]["load1"]["availability"] == "stale"
    evidence["stale"] = {"health": stale["device"]["health"], "last_received_at_ms": stale["ingest"]["last_received_at_ms"],
                         "generated_at_ms": stale["generated_at_ms"]}
    stop.set()

    # 5. Restart: unknown until the next fresh sample; a retry stays out_of_order.
    if not args.no_restart:
        seed = json.loads((STATE / "seed.json").read_text())
        subprocess.run([ROOT / "scripts/sandbox", "down"], check=True, timeout=120)
        up = [ROOT / "scripts/sandbox", "up", "--rows", str(seed["rows"]), "--seed", str(seed["seed"])]
        subprocess.run(up + (["--kiosk"] if args.kiosk else []), check=True, timeout=1800)
        restarted = view()
        assert restarted["device"]["health"]["status"] == "unknown", restarted["device"]["health"]
        assert restarted["warnings"] == ["waiting for first sample"], restarted["warnings"]
        status, body, _ = agent.post(retry, credential=token)
        assert body["reason"] == "out_of_order", body
        evidence["restart"] = {"health": "unknown", "warnings": restarted["warnings"], "retry": body["reason"],
                               "rows": rows()[0]}

    # 6. Recovery.
    process = client(args.interval)
    try:
        recovered = until("recovered console", 4 * args.interval + 10,
                          lambda: (v := view())["device"]["health"]["status"] not in ("unknown", "stale") and v)
        listed = get("/v1/devices")
    finally:
        process.terminate()
        process.wait(timeout=10)
    final, duplicates = rows()
    assert duplicates == 0, duplicates
    evidence["recovery"] = {"health": recovered["device"]["health"]["status"], "ingest": recovered["ingest"],
                            "devices": listed["devices"], "rows": final, "duplicate_rows": duplicates}
    (STATE / "devices-check.json").write_text(json.dumps(evidence, indent=2))
    print(json.dumps(evidence, indent=2))
    for secret in (token, token[5:]):
        assert secret not in json.dumps(evidence)
        assert secret not in (STATE / "fake-device-agent.log").read_text()
        assert secret not in (STATE / "factory-api.log").read_text()


if __name__ == "__main__":
    main()
