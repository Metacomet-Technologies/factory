#!/usr/bin/env python3
"""Compare legacy/v1 meters through identical real API binaries in the sandbox.

Run inside the scripts/sandbox Bubblewrap network/filesystem isolation with its
PATH shims. Arguments: legacy-meter v1-meter factory-api fake-ollama legacy.db
new-work-directory. The source is read-only; reports contain metering metadata
and must not be committed when using private data. Exit nonzero on A/B differences.
"""
import hashlib
import json
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


def read_rows(path):
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
        return {i: json.loads(text) for i, text in db.execute("SELECT id,record FROM requests ORDER BY id")}


MISSING = object()


def differences(left, right, path=""):
    if isinstance(left, dict) and isinstance(right, dict):
        return [diff for key in sorted(left.keys() | right.keys())
                for diff in differences(left.get(key, MISSING), right.get(key, MISSING),
                                        path + "/" + key.replace("~", "~0").replace("/", "~1"))]
    if isinstance(left, list) and isinstance(right, list):
        return [diff for i in range(max(len(left), len(right)))
                for diff in differences(left[i] if i < len(left) else MISSING,
                                        right[i] if i < len(right) else MISSING, f"{path}/{i}")]
    if left == right and type(left) is type(right):
        return []
    if left is MISSING or right is MISSING:
        kind = "missing vs null" if left is None or right is None else "missing field"
    elif type(left) in (int, float) and type(right) in (int, float):
        kind = "number representation" if left == right else "number value"
    elif type(left) is not type(right):
        kind = "type"
    else:
        kind = "value"
    return [dict(path=path, kind=kind, left="<missing>" if left is MISSING else left,
                 right="<missing>" if right is MISSING else right)]


def main():
    legacy_meter, meter, api, fake, source, work = map(lambda p: Path(p).resolve(), sys.argv[1:])
    # Fail closed if the sandbox boundary is absent; never probe production ports.
    routes = Path("/proc/net/route").read_text().splitlines()[1:]
    assert all(line.split()[0] == "lo" for line in routes), "requires sandbox network namespace"
    work.mkdir(mode=0o700)
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    raw = read_rows(source)
    shutil.copyfile(source, work / "a.db")
    started = time.monotonic()
    conversion = subprocess.run([meter, "migrate", "--legacy", source, "--db", work / "b.db"],
                                check=True, capture_output=True, text=True, timeout=60)
    report = dict(migration=json.loads(conversion.stdout), migration_wall_ms=(time.monotonic() - started) * 1000)
    (work / "fleet.toml").write_text('[[nodes]]\nname="sandbox"\nservices=[]\n')
    children = []
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def start(name, args):
        with (work / f"{name}.log").open("wb") as log:
            child = subprocess.Popen(args, stdout=log, stderr=log)
        children.append(child)

    def get(port, path):
        with opener.open(f"http://127.0.0.1:{port}{path}", timeout=5) as response:
            return json.load(response)

    def ready(port, path):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            assert all(child.poll() is None for child in children), "service exited; inspect sandbox logs"
            try:
                return get(port, path)
            except (OSError, ValueError):
                time.sleep(0.1)
        raise TimeoutError(f"service readiness: {port}{path}")

    try:
        # Fixed ports exist only inside the private namespace, with no host relay.
        for port in (21000, 21001, 21002, 21003, 21004):
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", port))
        start("fake", [fake, "--port", "21000", "--seed", "42"])
        ready(21000, "/api/version")
        for name, binary, port in [("a", legacy_meter, 21001), ("b", meter, 21002)]:
            start(name, [binary, "--listen", f"127.0.0.1:{port}", "--upstream", "http://127.0.0.1:21000",
                         "--db-path", work / f"{name}.db", "--gpu-sample-interval", "3600"])
            ready(port, "/meter/health")
            pricing = work / f"{name}-pricing.db"
            subprocess.run([api, "migrate", "--pricing-db", pricing], check=True, capture_output=True, timeout=30)
            start(f"{name}-api", [api, "--listen", f"127.0.0.1:{port+2}", "--meter-url", f"http://127.0.0.1:{port}",
                                  "--db-path", work / f"{name}-cache.db", "--pricing-db-path", pricing,
                                  "--services-config", work / "fleet.toml", "--disable-pricing-collector"])
            ready(port + 2, "/v1/health")
        deadline = time.monotonic() + 60
        while True:
            a, b = [read_rows(work / f"{name}-cache.db") for name in ("a", "b")]
            if a.keys() == raw.keys() and b.keys() == raw.keys():
                break
            assert time.monotonic() < deadline, f"sync incomplete: {len(a)}, {len(b)} / {len(raw)}"
            time.sleep(0.1)
        # Keep all differences, rather than masking fields or using a tolerance.
        report["rows"] = len(raw)
        report["a_vs_b"] = {str(i): diff for i in raw if (diff := differences(a[i], b[i]))}
        report["raw_vs_a"] = {str(i): diff for i in raw if (diff := differences(raw[i], a[i]))}
        wire_a = {}
        cursor = 0
        while True:
            page = get(21001, f"/meter/requests?after_id={cursor}&limit=500")
            if not page:
                break
            wire_a.update((row["id"], row) for row in page)
            cursor = page[-1]["id"]
        report["legacy_wire_vs_a"] = {str(i): diff for i in raw if (diff := differences(wire_a[i], a[i]))}
        report["usage"] = {window: {name: get(port, f"/v1/llm/usage?range={window}")["totals"]
                                    for name, port in [("a", 21003), ("b", 21004)]}
                           for window in ("24h", "7d", "30d")}
        assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash, "source changed"
        print(json.dumps(report, indent=2), flush=True)
        assert not report["a_vs_b"], "A/B cache mismatch; see complete report"
        assert all(pair["a"] == pair["b"] for pair in report["usage"].values()), "A/B usage mismatch"
    finally:
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


if __name__ == "__main__":
    main()
