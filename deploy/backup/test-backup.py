#!/usr/bin/env python3
"""No-root contract check: live WAL writers, retention, failures and restores."""

import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import threading
import time

HERE = Path(__file__).resolve().parent


def run(script, env, *args, success=True):
    result = subprocess.run(["bash", str(HERE / script), *args], env=env,
                            text=True, capture_output=True, timeout=60)
    assert (result.returncode == 0) == success, result.stdout + result.stderr
    return result.stdout + result.stderr


def seed(directory):
    directory.mkdir(parents=True, exist_ok=True)
    today = dt.datetime.now(dt.timezone.utc).date()
    for age in range(1, 41):
        day = today - dt.timedelta(days=age)
        name = day.strftime("%Y%m%d") + "T120000.000000000Z.db.zst"
        path = directory / name
        path.write_bytes(f"fake dated snapshot {age}".encode())
        Path(str(path) + ".sha256").write_text(
            f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {name}\n")


def writer(path, stop, ready):
    with sqlite3.connect(path) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA wal_autocheckpoint=0")
        db.executescript('CREATE TABLE events(id INTEGER); CREATE TABLE children(id INTEGER);'
                         'CREATE TABLE "odd""table"(id INTEGER);'
                         'INSERT INTO "odd""table" VALUES(1),(2),(3);')
        ready.set()
        while not stop.is_set():
            with db:
                db.execute("INSERT INTO events VALUES(1)")
                db.execute("INSERT INTO children VALUES(1)")
            time.sleep(0.002)


with tempfile.TemporaryDirectory(prefix="factory-backup-test ' ") as temp:
    root = Path(temp)
    stop = threading.Event()
    threads = []
    environments = {}
    try:
        for host, names in (("factory-gpu", ["meter"]),
                            ("factory-console", ["requests", "pricing"])):
            peer = "factory-console" if host == "factory-gpu" else "factory-gpu"
            env = dict(os.environ, BACKUP_HOST=host, BACKUP_TRANSPORT="local",
                       LOCAL_ROOT=str(root / "local"),
                       REPLICA_ROOT=str(root / host / "replica"),
                       PEER_REPLICA_ROOT=str(root / peer / "replica"),
                       STATUS_FILE=str(root / host / "status" / "status.json"))
            env.pop("BACKUP_CONFIG", None)
            environments[host] = env
            for name in names:
                db = root / f"{name}.db"
                env[f"{name.upper()}_DB"] = str(db)
                ready = threading.Event()
                thread = threading.Thread(target=writer, args=(db, stop, ready))
                thread.start()
                threads.append(thread)
                assert ready.wait(5)
                seed(root / "local" / host / name)
                seed(root / peer / "replica" / host / name)
            # Same-day duplicate: keep the later copy, not two copies per day.
            directory = root / "local" / host / names[0]
            first = sorted(directory.glob("*.db.zst"))[-1]
            duplicate = directory / first.name.replace("T120000", "T230000")
            duplicate.write_bytes(first.read_bytes())
            Path(str(duplicate) + ".sha256").write_text(
                f"{hashlib.sha256(duplicate.read_bytes()).hexdigest()}  {duplicate.name}\n")
            orphan_day = dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=3)
            orphan = directory / (orphan_day.strftime("%Y%m%d") + "T235959.000000000Z.db.zst")
            orphan.write_bytes(b"interrupted publication without a checksum")
            with sqlite3.connect(root / f"{names[0]}.db") as db:
                before = db.execute("SELECT count(*) FROM events").fetchone()[0]
            run("factory-backup.sh", env)
            assert not orphan.exists()
            with sqlite3.connect(root / f"{names[0]}.db") as db:
                assert db.execute("SELECT count(*) FROM events").fetchone()[0] > before
            status = json.loads(Path(env["STATUS_FILE"]).read_text())
            today = dt.datetime.now(dt.timezone.utc).date()
            # Independent calendar expectation: seven days plus four Sundays.
            sunday_age = (today.weekday() + 1) % 7
            expected_days = {today - dt.timedelta(days=age)
                             for age in list(range(7)) + [sunday_age + 7 * n for n in range(4)]}
            for name in names:
                for tree in (root / "local" / host, root / peer / "replica" / host):
                    copies = sorted((tree / name).glob("*.db.zst"))
                    assert len(copies) == len(expected_days), copies
                    assert {dt.datetime.strptime(p.name[:8], "%Y%m%d").date()
                            for p in copies} == expected_days
                    assert len(list((tree / name).glob("*.sha256"))) == len(copies)
                    if name == names[0]:
                        assert duplicate.name in {p.name for p in copies}
                    latest = copies[-1]
                    subprocess.run(["zstd", "-q", "-t", str(latest)], check=True)
                    subprocess.run(["sha256sum", "-c", latest.name + ".sha256"],
                                   cwd=latest.parent, check=True, capture_output=True)
                    restored = root / "restored.db"
                    subprocess.run(["zstd", "-q", "-d", "-f", str(latest), "-o", str(restored)], check=True)
                    with sqlite3.connect(restored) as db:
                        assert db.execute("PRAGMA integrity_check").fetchone() == ("ok",)
                        assert db.execute("SELECT count(*) FROM events").fetchone() == \
                            db.execute("SELECT count(*) FROM children").fetchone()
                        if name == names[0]:
                            assert db.execute("SELECT count(*) FROM events").fetchone()[0] >= before
                        assert db.execute('SELECT count(*) FROM "odd""table"').fetchone() == (3,)
                entry = status[name]
                assert entry["last_success_ms"] >= entry["last_attempt_ms"] > 0
                assert entry["integrity"] == "ok" and entry["pushed_to_peer"]
                assert entry["error"] is None and entry["size_bytes"] > 0
        print("PASS: three live WAL snapshots, integrity, zstd, checksum, local/replica retention")
    finally:
        stop.set()
        for thread in threads:
            thread.join(5)
            assert not thread.is_alive()

    live_files = {path: hashlib.sha256(path.read_bytes()).digest() for path in root.glob("*.db*")}
    for env in environments.values():
        output = run("restore-check.sh", env, "all")
        assert output.count("integrity_check=ok") == 3, output
        assert output.count('odd"table: 3 rows') == 3, output
    assert all(hashlib.sha256(path.read_bytes()).digest() == digest for path, digest in live_files.items())
    print("PASS: restore-check reports every table and never changes live databases")

    env = environments["factory-console"]
    trees = [root / "local" / "factory-console", root / "factory-gpu" / "replica" / "factory-console"]
    for tree in trees:
        for name in ("requests", "pricing"):
            seed(tree / name)
    prior_files = {path for tree in trees for path in tree.rglob("*.db.zst*")}
    previous = json.loads(Path(env["STATUS_FILE"]).read_text())
    run("factory-backup.sh", dict(env, PRICING_DB=str(root / "missing.db")), success=False)
    assert all(path.exists() for path in prior_files)
    status = json.loads(Path(env["STATUS_FILE"]).read_text())
    for name in ("requests", "pricing"):
        assert status[name]["last_success_ms"] == previous[name]["last_success_ms"]
        assert not status[name]["pushed_to_peer"] and status[name]["error"]
    bad = root / "invalid.db"
    bad.write_text("not sqlite")
    run("factory-backup.sh", dict(env, PRICING_DB=str(bad)), success=False)
    assert all(path.exists() for path in prior_files)
    blocked = root / "blocked"
    blocked.write_text("not a directory")
    run("factory-backup.sh", dict(env, PEER_REPLICA_ROOT=str(blocked)), success=False)
    assert all(path.exists() for path in prior_files)
    status = json.loads(Path(env["STATUS_FILE"]).read_text())
    assert all(value["integrity"] == "ok" and not value["pushed_to_peer"]
               and value["error"] for value in status.values())
    print("PASS: missing/corrupt DB and failed push exit nonzero; neither tree loses files")
    run("factory-backup.sh", env)
    status = json.loads(Path(env["STATUS_FILE"]).read_text())
    assert all(value["pushed_to_peer"] and value["error"] is None
               and value["last_success_ms"] > previous[name]["last_success_ms"]
               for name, value in status.items())
    print("PASS: retry after failures clears errors and resumes retention")

    gpu = environments["factory-gpu"]
    replica = root / "factory-gpu" / "replica" / "factory-console"
    current = sorted((replica / "pricing").glob("*.db.zst"))[-1]
    checksum = Path(str(current) + ".sha256")
    checksum.unlink()
    before_files = {path for path in replica.rglob("*") if path.is_file()}
    run("factory-backup.sh", gpu, "--prune-replica")
    assert all(path.exists() for path in before_files)
    run("restore-check.sh", gpu, "replica", success=False)
    checksum.write_text(f"{'0' * 64}  {current.name}\n")
    run("factory-backup.sh", gpu, "--prune-replica", success=False)
    assert all(path.exists() for path in before_files)
    run("restore-check.sh", gpu, "replica", success=False)
    for path in (replica / "pricing").glob(today.strftime("%Y%m%d") + "*"):
        path.unlink()
    before_files = {path for path in replica.rglob("*") if path.is_file()}
    run("factory-backup.sh", gpu, "--prune-replica")
    assert all(path.exists() for path in before_files)
    print("PASS: receiver skips retention without today's complete backups; checksum corruption fails")
