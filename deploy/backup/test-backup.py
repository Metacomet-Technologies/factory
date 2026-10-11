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

    # Exercise the actual access probe under the current unprivileged identity.
    assert os.geteuid() != 0, "Run these permission checks without root"
    home = root / "access-home"
    home.mkdir(mode=0o700)
    access = dict(gpu, BACKUP_HOME=str(home), HOME=str(root / "unrelated-home"))
    known = home / "known_hosts"
    known.write_text("preserve this host key\n")
    known.chmod(0o600)
    parent = Path(gpu["REPLICA_ROOT"]).parent
    original_mode = parent.stat().st_mode & 0o777
    parent.chmod(0o600)  # No execute bit: the kernel denies ancestor traversal.
    try:
        output = run("factory-backup.sh", access, "--check-access", success=False)
        assert "Cannot traverse/read/write replica root" in output
    finally:
        parent.chmod(original_mode)
    home.chmod(0o500)
    try:
        run("factory-backup.sh", access, "--check-access", success=False)
    finally:
        home.chmod(0o700)
    known.chmod(0o400)
    try:
        run("factory-backup.sh", access, "--check-access", success=False)
    finally:
        known.chmod(0o600)
    known.unlink()
    victim = root / "must-not-truncate"
    victim.write_text("leave unchanged")
    known.symlink_to(victim)
    run("factory-backup.sh", access, "--check-access", success=False)
    assert victim.read_text() == "leave unchanged"
    known.unlink()
    known.write_text("preserve this host key\n")
    known.chmod(0o600)
    run("factory-backup.sh", access, "--check-access")
    assert known.read_text() == "preserve this host key\n"
    assert not list(Path(access["REPLICA_ROOT"]).glob(".access.*"))
    # The root lock no longer follows a file in the SSH user's writable home.
    old_lock = Path(env["STATUS_FILE"]).parent / "backup.lock"
    old_lock.symlink_to(victim)
    run("factory-backup.sh", env)
    assert victim.read_text() == "leave unchanged"
    print("PASS: kernel traversal/write failures and unsafe known_hosts fail; legacy lock cannot truncate files")

    # No root: account commands and ownership are modelled; all directory modes,
    # key migration, access probes, file contents and deletions use the real FS.
    account_harness = r'''
set -Eeuo pipefail
fail() { echo "$*" >&2; exit 1; }
id() {
    local user=${@: -1}
    [[ -f "$FIXTURE/$user" ]] || return 1
    case $1 in
        -u) cut -d: -f3 "$FIXTURE/$user" ;;
        -Gn) printf '%s\n' "$user" ;;
    esac
}
getent() {
    if [[ $1 == passwd ]]; then
        [[ -f "$FIXTURE/$2" ]] || return 1
        cat "$FIXTURE/$2"
    else
        [[ -f "$FIXTURE/$2" ]] || return 1
        printf '%s:x:900:\n' "$2"
    fi
}
usermod() {
    local user=${@: -1} name password uid gid description home shell
    IFS=: read -r name password uid gid description home shell < "$FIXTURE/$user"
    while (( $# > 1 )); do
        case $1 in
            --home) home=$2; shift 2 ;;
            --shell) shell=$2; shift 2 ;;
            --password) password=$2; shift 2 ;;
            --lock) password="!${password#!}"; shift ;;
            *) fail "Unexpected usermod option: $1" ;;
        esac
    done
    printf '%s:%s:%s:%s:%s:%s:%s\n' "$name" "$password" "$uid" "$gid" "$description" "$home" "$shell" > "$FIXTURE/$user"
}
useradd() {
    local user=${@: -1} home shell
    while (( $# > 1 )); do
        case $1 in
            --home-dir) home=$2; shift 2 ;;
            --shell) shell=$2; shift 2 ;;
            --system|--user-group|--no-create-home) shift ;;
            *) fail "Unexpected useradd option: $1" ;;
        esac
    done
    printf '%s:!:900:900::%s:%s\n' "$user" "$home" "$shell" > "$FIXTURE/$user"
}
install() {
    local owner group args=() paths=()
    while (( $# )); do
        case $1 in
            -o) owner=$2; shift 2 ;;
            -g) group=$2; shift 2 ;;
            -m) args+=("$1" "$2"); shift 2 ;;
            -d) args+=("$1"); shift ;;
            *) args+=("$1"); paths+=("$1"); shift ;;
        esac
    done
    command install "${args[@]}"
    for path in "${paths[@]}"; do
        printf '%s\t%s\t%s\n' "$owner" "$group" "$path" >> "$FIXTURE/owners"
    done
}
chown() {
    [[ $1 == -hR ]] || fail 'Recursive chown must not follow links'
    find "$3" -print | while IFS= read -r path; do
        printf '%s\t%s\t%s\n' "${2%:*}" "${2#*:}" "$path" >> "$FIXTURE/owners"
    done
}
chgrp() {
    [[ $1 == -hR ]] || fail 'Recursive chgrp must not follow links'
    find "$3" -print | while IFS= read -r path; do
        printf 'root\t%s\t%s\n' "$2" "$path" >> "$FIXTURE/owners"
    done
}
runuser() {
    [[ $1 == -u && $2 == factory-backup && $3 == -- ]] || fail 'Wrong runtime account'
    shift 3
    "$@"
}
source "$ACCOUNT_SCRIPT"
preflight_backup_account
prepare_backup_account
'''
    for host in ("factory-gpu", "factory-console"):
        for already_restored, has_keys in ((False, True), (True, True), (True, False)):
            fixture = root / f"migration-{host}-{already_restored}-{has_keys}"
            fixture.mkdir()
            replica = fixture / ("srv/factory/backups/replica" if host == "factory-gpu"
                                 else "var/backups/factory-replica")
            legacy_ssh = replica / ".ssh"
            legacy_ssh.mkdir(parents=True)
            replica.parent.chmod(0o700)
            legacy_ssh.chmod(0o700)
            old_key = "factory-peer ssh-ed25519 old-trusted-key\n"
            if has_keys:
                (legacy_ssh / "known_hosts").write_text(old_key)
                (legacy_ssh / "known_hosts.old").write_text("obsolete key\n")
            archive = replica / host / "test.db.zst"
            archive.parent.mkdir()
            archive.write_bytes(b"preserve replica data")
            local = fixture / "var/backups/factory-db"
            local_archive = local / host / "test.db.zst"
            local_archive.parent.mkdir(parents=True)
            local_archive.write_bytes(b"preserve local data")
            home = fixture / "var/lib/factory-backup"
            home.mkdir(mode=0o700, parents=True)
            status = home / "status.json"
            status.write_text('{"last_success_ms":123}')
            (home / "backup.lock").touch()
            known = home / "known_hosts"
            new_key = "factory-other ssh-ed25519 new-trusted-key\n"
            if has_keys:
                known.write_text(new_key)
            builtin = fixture / "backup"
            # An already-restored account retains its password state too.
            default_account = f"backup:{'!*' if already_restored else '*'}:34:34:backup:/var/backups:/usr/sbin/nologin\n"
            builtin.write_text(default_account if already_restored else
                               f"backup:!*:34:34:backup:{replica}:/bin/sh\n")
            migration_env = dict(os.environ, FIXTURE=str(fixture), ACCOUNT_SCRIPT=str(HERE / "account.sh"),
                                 BACKUP_CONFIG=str(HERE / "nodes.conf"), BACKUP_HOST=host,
                                 BACKUP_USER="factory-backup", BACKUP_HOME=str(home),
                                 REPLICA_ROOT=str(replica), LOCAL_ROOT=str(local))
            for attempt in range(2):
                result = subprocess.run(["bash", "-c", account_harness], env=migration_env,
                                        text=True, capture_output=True, timeout=30)
                assert result.returncode == 0, result.stdout + result.stderr
                assert builtin.read_text() == default_account
                account = (fixture / "factory-backup").read_text().split(":")
                assert account[1].startswith("!") and account[5] == str(home) and account[6].strip() == "/bin/sh"
                assert replica.stat().st_mode & 0o777 == 0o700
                assert replica.parent.stat().st_mode & 0o777 == 0o711
                assert home.stat().st_mode & 0o777 == 0o700
                assert known.stat().st_mode & 0o777 == 0o600
                assert known.read_text() == ("".join(sorted([old_key, new_key])) if has_keys else "")
                assert not legacy_ssh.exists() and not (home / "backup.lock").exists()
                assert archive.read_bytes() == b"preserve replica data"
                assert local_archive.read_bytes() == b"preserve local data"
                assert status.read_text() == '{"last_success_ms":123}'
                owners = {}
                for line in (fixture / "owners").read_text().splitlines():
                    owner, group, path = line.split("\t")
                    owners[path] = (owner, group)
                assert owners[str(replica)] == owners[str(archive)] == ("factory-backup", "factory-backup")
                assert owners[str(home)] == ("factory-backup", "factory-backup")
                assert owners[str(local_archive)] == ("root", "factory-backup")
                assert owners[str(replica.parent)] == ("root", "root")
                run("factory-backup.sh", migration_env, "--check-access")
            # Do not silently remove administrator-added SSH keys or trust links.
            legacy_ssh.mkdir()
            key = legacy_ssh / "authorized_keys"
            key.write_text("administrator-added key")
            result = subprocess.run(["bash", "-c", account_harness], env=migration_env,
                                    text=True, capture_output=True, timeout=30)
            assert result.returncode != 0 and "Review unexpected legacy SSH artifact" in result.stderr
            assert key.read_text() == "administrator-added key"
    print("PASS: both-node legacy/already-restored migrations are idempotent; accounts, data and host keys preserved")
