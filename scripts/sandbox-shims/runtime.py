#!/usr/bin/env python3
"""Private network namespace and fixed-destination loopback/Unix relays (Linux)."""
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

MODE, ROOT = sys.argv[1], Path(sys.argv[2]).resolve()
STATE = ROOT / ".sandbox"
BASE = 20000 + int.from_bytes(hashlib.sha256(os.fsencode(ROOT)).digest()[:4], "big") % 9997
SERVICES = {"fake-ollama": BASE, "meter": BASE + 1, "factory-api": BASE + 2}
STOP = threading.Event()


def identity(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return None if fields[0] == "Z" else fields[19]
    except FileNotFoundError:
        return None


def running():
    try:
        pid, start = (STATE / "runtime.pid").read_text().split()
        return int(pid) if identity(int(pid)) == start else None
    except FileNotFoundError:
        return None


def atomic(path, text):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(text)
    temporary.replace(path)


def request(port, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data,
                                 headers={"Content-Type": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=5) as response:
        return json.load(response)


def ready(port, path, seconds=60):
    deadline = time.monotonic() + seconds
    while not STOP.is_set() and time.monotonic() < deadline:
        try:
            return request(port, path)
        except (OSError, ValueError):
            STOP.wait(0.2)
    raise RuntimeError(f"Timed out waiting for 127.0.0.1:{port}{path}")


def relay(client, destination, family):
    try:
        with client, socket.socket(family) as upstream:
            upstream.settimeout(5)
            upstream.connect(destination)
            upstream.settimeout(None)
            peers = {client: upstream, upstream: client}
            while peers and not STOP.is_set():
                readable, _, _ = select.select(list(peers), [], [], 1)
                for source in readable:
                    data = source.recv(65536)
                    if data:
                        peers[source].sendall(data)
                    else:
                        peers[source].shutdown(socket.SHUT_WR)
                        del peers[source]
    except OSError:
        pass  # A disconnected client/stream must not stop other requests.


def accept(listener, destination, family):
    listener.settimeout(0.5)
    while not STOP.is_set():
        try:
            client, _ = listener.accept()
        except TimeoutError:
            continue
        threading.Thread(target=relay, args=(client, destination, family), daemon=True).start()


def listeners(inside):
    opened = []
    try:
        for name, port in SERVICES.items():
            path = str(STATE / f"{name}.sock")
            listener = socket.socket(socket.AF_UNIX if inside else socket.AF_INET)
            opened.append(listener)
            if inside:
                Path(path).unlink(missing_ok=True)
                listener.bind(path)
                destination, family = ("127.0.0.1", port), socket.AF_INET
            else:
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    listener.bind(("127.0.0.1", port))
                except OSError as error:
                    raise RuntimeError(f"Port {port} already in use; sandbox not started") from error
                destination, family = path, socket.AF_UNIX
            listener.listen(64)
            threading.Thread(target=accept, args=(listener, destination, family), daemon=True).start()
        return opened
    except BaseException:
        for listener in opened:
            listener.close()
        raise


def inside():
    rows, seed, kiosk = sys.argv[3:]
    children = []
    signal.signal(signal.SIGTERM, lambda *_: STOP.set())
    signal.signal(signal.SIGINT, lambda *_: STOP.set())

    def start(name, args):
        with (STATE / f"{name}.log").open("ab") as log:
            child = subprocess.Popen(args, stdout=log, stderr=log)
        children.append(child)
        (STATE / f"{name}.namespace-pid").write_text(str(child.pid))
        return child

    try:
        # No external routes exist. These probes cannot reach host services or internet.
        isolation = {}
        for address in [("127.0.0.1", 11434), ("127.0.0.1", 11435), ("192.0.2.1", 443)]:
            try:
                with socket.create_connection(address, timeout=1):
                    raise RuntimeError(f"Isolation failed: {address} reachable")
            except OSError as error:
                isolation[str(address)] = str(error)
        atomic(STATE / "isolation.json", json.dumps(isolation, indent=2))
        binary = ROOT / "target/release"
        start("fake-ollama", [binary / "fake-ollama", "--port", str(BASE), "--seed", seed])
        ready(BASE, "/api/version")
        if not (STATE / "seed.json").exists():
            end_ms = int(time.time() // 86400) * 86400000
            child = start("seed", [binary / "sandbox-seed", "--legacy", "--db-path", STATE / "meter.v0.db",
                                  "--rows", rows, "--seed", seed, "--days", "30", "--end-ms", str(end_ms)])
            if child.wait() != 0:
                raise RuntimeError("Seeding failed; see seed.log; reset before retrying")
            with (STATE / "meter-bad-row.log").open("ab") as log:
                subprocess.run([binary / "sandbox-seed", "--legacy", "--bad-row", "--db-path", STATE / "meter.bad.v0.db",
                                "--rows", "1", "--end-ms", str(end_ms)], stdout=log, stderr=log, check=True, timeout=60)
                bad = subprocess.run([binary / "meter", "migrate", "--legacy", STATE / "meter.bad.v0.db",
                                      "--db", STATE / "meter.bad.v1.db"], stdout=log, stderr=log, timeout=60)
            if bad.returncode == 0 or (STATE / "meter.bad.v1.db").exists():
                raise RuntimeError("Invalid legacy row was not refused cleanly; see meter-bad-row.log")
            atomic(STATE / "seed.json", json.dumps(dict(rows=int(rows), seed=int(seed), end_ms=end_ms)))
        meter_db = STATE / "meter.db"
        legacy_db = STATE / "meter.v0.db"
        version = None
        if meter_db.exists():
            with sqlite3.connect(meter_db.as_uri() + "?mode=ro", uri=True) as db:
                version = db.execute("PRAGMA user_version").fetchone()[0]
        if version != 1:
            if version not in (None, 0):
                raise RuntimeError(f"Unsupported meter user_version={version}")
            source = meter_db if version == 0 else legacy_db
            target = STATE / "meter.v1.db" if version == 0 else meter_db
            if version == 0 and legacy_db.exists():
                raise RuntimeError("Legacy preservation collision: meter.v0.db")
            for dry_run, filename in [(True, "meter-dry-run.json"), (False, "meter-migration.json")]:
                args = [binary / "meter", "migrate", "--legacy", source, "--db", target]
                if dry_run:
                    args.append("--dry-run")
                with (STATE / filename).open("wb") as log:
                    result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, timeout=60)
                if result.returncode != 0:
                    raise RuntimeError(f"Meter migration failed; see {filename}; startup stopped")
            if version == 0:
                for suffix in ("", "-wal", "-shm"):
                    old = Path(str(meter_db) + suffix)
                    if old.exists():
                        old.rename(Path(str(legacy_db) + suffix))
                target.rename(meter_db)
        start("meter", [binary / "meter", "--listen", f"127.0.0.1:{BASE+1}",
                        "--upstream", f"http://127.0.0.1:{BASE}", "--db-path", STATE / "meter.db",
                        "--gpu-sample-interval", "2"])
        ready(BASE + 1, "/meter/health")
        fleet = '[[nodes]]\nname = "sandbox"\n'
        for name, path in [("fake-ollama", "/api/version"), ("meter", "/meter/health"), ("factory-api", "/v1/health")]:
            fleet += f'[[nodes.services]]\nname = "{name}"\nkind = "http"\ntarget = "http://127.0.0.1:{SERVICES[name]}{path}"\n'
        (STATE / "fleet.toml").write_text(fleet)
        with (STATE / "factory-api.log").open("ab") as log:
            migration = subprocess.run([binary / "factory-api", "migrate", "--pricing-db", STATE / "pricing.db"],
                                       stdout=log, stderr=log)
        if migration.returncode != 0:
            raise RuntimeError(f"Pricing migration failed (exit {migration.returncode}); see factory-api.log")
        start("factory-api", [binary / "factory-api", "--listen", f"127.0.0.1:{BASE+2}",
                              "--meter-url", f"http://127.0.0.1:{BASE+1}", "--db-path", STATE / "requests.db",
                              "--pricing-db-path", STATE / "pricing.db", "--services-config", STATE / "fleet.toml",
                              "--openrouter-feed-url", f"http://127.0.0.1:{BASE}/feeds/openrouter",
                              "--litellm-feed-url", f"http://127.0.0.1:{BASE}/feeds/litellm",
                              "--disable-pricing-collector",
                              "--static-dir", ROOT / "kiosk/dist" if kiosk == "1" else STATE / "no-kiosk"])
        ready(BASE + 2, "/v1/health")
        started = time.monotonic()
        pricing = {"refresh": request(BASE + 2, "/v1/pricing/refresh", {})}
        pricing["confirm"] = {}
        for family in pricing["refresh"]["families"]:
            name = family["family"]
            if family["pending"] is not None:
                path = "/v1/pricing/confirm/" + urllib.parse.quote(name, safe="")
                pricing["confirm"][name] = request(BASE + 2, path, {})
            else:
                assert family["selected"] is not None, f"No candidate for {name}: {pricing['refresh']}"
        pricing["snapshot"] = request(BASE + 2, "/v1/pricing")
        assert len(pricing["snapshot"]["families"]) == 2
        assert not pricing["snapshot"]["warnings"], pricing["snapshot"]
        for family in pricing["snapshot"]["families"]:
            assert family["selected"] is not None and family["pending"] is None
            assert family["rates"]["input_per_mtok"] == 2
            assert family["rates"]["output_per_mtok"] == 10
        pricing["refresh_confirm_ms"] = (time.monotonic() - started) * 1000
        atomic(STATE / "pricing-check.json", json.dumps(pricing, indent=2))
        request(BASE + 1, "/api/generate", {"model": "factory-assist", "prompt": "pricing check", "stream": False})
        sockets = listeners(True)
        atomic(STATE / "ready", "ready\n")
        index = 0
        while not STOP.wait(2) and not (STATE / "stop").exists():
            if any(child.poll() is not None for child in children if child.args[0] != binary / "sandbox-seed"):
                raise RuntimeError("A sandbox service exited; see service logs")
            try:
                request(BASE + 1, "/api/generate", {"model": ["factory-assist", "factory-assist-max", "factory-code"][index % 3],
                                                  "prompt": f"sandbox ticker {index}", "stream": False})
                index += 1
            except OSError as error:
                with (STATE / "traffic.log").open("a") as log:
                    print(error, file=log)
        for listener in sockets:
            listener.close()
    finally:
        STOP.set()
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=6)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


def run():
    sockets = listeners(False)  # Reserve every host port before starting anything.
    atomic(STATE / "runtime.pid", f"{os.getpid()} {identity(os.getpid())}\n")
    atomic(STATE / "ports.json", json.dumps(SERVICES, indent=2))
    (STATE / "ready").unlink(missing_ok=True)
    (STATE / "stop").unlink(missing_ok=True)
    signal.signal(signal.SIGTERM, lambda *_: STOP.set())
    signal.signal(signal.SIGINT, lambda *_: STOP.set())
    child = subprocess.Popen([
        "bwrap", "--unshare-net", "--unshare-pid", "--unshare-uts", "--hostname", "sandbox",
        "--die-with-parent", "--ro-bind", "/", "/",
        "--bind", str(STATE), str(STATE), "--proc", "/proc", "--dev", "/dev",
        "--tmpfs", "/run", "--tmpfs", "/tmp", "--setenv", "PATH",
        f"{ROOT}/scripts/sandbox-shims:/usr/bin:/bin",
        "python3", str(Path(__file__).resolve()), "inside", str(ROOT), *sys.argv[3:]])
    try:
        while child.poll() is None and not STOP.wait(0.2):
            pass
        if not STOP.is_set() and child.returncode:
            raise RuntimeError(f"Namespace exited with status {child.returncode}")
    finally:
        STOP.set()
        # Ask the namespace supervisor to drain its services before tearing it down.
        (STATE / "stop").touch()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
        for listener in sockets:
            listener.close()
        (STATE / "ready").unlink(missing_ok=True)
        (STATE / "runtime.pid").unlink(missing_ok=True)


def down():
    pid = running()
    if pid is None:
        print("Sandbox stopped")
        return
    # pidfd plus start time prevents stale pidfiles from signalling unrelated processes.
    fd = os.pidfd_open(pid)
    try:
        if running() != pid:
            raise RuntimeError("Sandbox PID changed; refusing to signal")
        signal.pidfd_send_signal(fd, signal.SIGTERM)
        if not select.select([fd], [], [], 20)[0]:
            raise RuntimeError("Sandbox shutdown timed out; inspect runtime.log")
    finally:
        os.close(fd)
    print("Sandbox stopped")


def status():
    print("Sandbox running" if running() else "Sandbox stopped")
    for name, port in SERVICES.items():
        print(f"{name}: http://127.0.0.1:{port}")


if __name__ == "__main__":
    try:
        if MODE == "inside":
            inside()
        elif MODE == "run":
            run()
        elif MODE == "preflight":
            if running():
                raise RuntimeError("Sandbox already running; use status, down, or reset")
            if (STATE / "seed.json").exists():
                saved = json.loads((STATE / "seed.json").read_text())
                if (saved["rows"], saved["seed"]) != tuple(map(int, sys.argv[3:5])):
                    raise RuntimeError("Existing seed/rows differ; use reset to replace data")
            for port in SERVICES.values():
                with socket.socket() as probe:
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    try:
                        probe.bind(("127.0.0.1", port))
                    except OSError as error:
                        raise RuntimeError(f"Port {port} already in use; sandbox not started") from error
        elif MODE == "wait":
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                if identity(int(sys.argv[3])) is None:
                    raise RuntimeError("Startup failed; see .sandbox/runtime.log and service logs")
                if (STATE / "ready").exists() and running():
                    ready(BASE + 1, "/meter/health")
                    ready(BASE + 2, "/v1/health")
                    status()
                    break
                time.sleep(0.2)
            else:
                down()
                raise RuntimeError("Startup failed; see .sandbox/runtime.log and service logs")
        elif MODE == "down":
            down()
        elif MODE == "status":
            status()
        else:
            raise RuntimeError(f"Unknown runtime command: {MODE}")
    except (OSError, RuntimeError, ValueError) as error:
        sys.exit(str(error))
