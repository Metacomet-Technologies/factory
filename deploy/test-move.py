#!/usr/bin/env python3
"""No-root restore contract: exact table counts, corruption and stale-WAL refusal."""
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent


def run(*args, success=True):
    result = subprocess.run(["python3", "-B", str(HERE / "move-db.py"), *map(str, args)],
                            capture_output=True, text=True, timeout=30)
    assert (result.returncode == 0) == success, result.stdout + result.stderr
    return result


with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    bundle = root / "bundle"
    bundle.mkdir()
    expected = {}
    for name, count in (("requests", 7), ("pricing", 3)):
        source = root / f"{name}.db"
        with sqlite3.connect(source) as db:
            db.executescript('PRAGMA user_version=1; CREATE TABLE "odd""table"(id INTEGER);'
                             'CREATE TABLE empty_table(id INTEGER);')
            db.executemany('INSERT INTO "odd""table" VALUES(?)', [(i,) for i in range(count)])
        archive = bundle / f"{name}.db.zst"
        subprocess.run(["zstd", "-q", str(source), "-o", str(archive)], check=True)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        (bundle / f"{archive.name}.sha256").write_text(f"{digest}  {archive.name}\n")
        expected[name] = {"user_version": 1, "tables": {'odd"table': count, "empty_table": 0}, "sha256": digest}
    run("manifest", bundle)
    assert json.loads((bundle / "counts.json").read_text()) == expected
    run("verify", bundle)
    target = root / "restored"
    target.mkdir()
    wal = target / "pricing.db-wal"
    wal.write_bytes(b"stale committed WAL must never be replayed")
    run("restore", bundle, target, success=False)
    assert wal.read_bytes() == b"stale committed WAL must never be replayed"
    assert not (target / "requests.db").exists()
    wal.unlink()
    checksum = bundle / "pricing.db.zst.sha256"
    good = checksum.read_text()
    checksum.write_text("0" * 64 + "  pricing.db.zst\n")
    run("restore", bundle, target, success=False)
    assert not list(target.iterdir())
    checksum.write_text(good)
    run("restore", bundle, target)
    run("compare", bundle, target)
    for name in expected:
        assert (target / f"{name}.db").stat().st_mode & 0o777 == 0o600
        with sqlite3.connect(target / f"{name}.db") as db:
            assert db.execute('SELECT id FROM "odd""table" ORDER BY id').fetchall() == [
                (i,) for i in range(expected[name]["tables"]['odd"table'])]
    before = {p.name: p.read_bytes() for p in target.iterdir()}
    run("restore", bundle, target, success=False)
    assert before == {p.name: p.read_bytes() for p in target.iterdir()}
    with sqlite3.connect(target / "requests.db") as db:
        db.execute('INSERT INTO "odd""table" VALUES(99)')
    run("compare", bundle, target, success=False)
    print("PASS: all-table counts/data/modes; checksum corruption, stale WAL, existing DB and count drift refused")
