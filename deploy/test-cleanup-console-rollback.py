#!/usr/bin/env python3
"""Unprivileged MET-118 cleanup tests with a fake root and PATH shims.

No sudo, no real units, users or Tailscale. Real sqlite3, zstd and sha256sum.
"""

import hashlib
import os
import pathlib
import sqlite3
import subprocess
import tempfile
import unittest

here = pathlib.Path(__file__).resolve().parent
SCRIPT = here / "cleanup-console-rollback.sh"

SHIMS = {
    "hostname": 'echo "${FAKE_HOSTNAME:-factory-console}"',
    "systemctl": """echo "systemctl $*" >> "$CONSOLE_CLEANUP_TEST_ROOT/calls"
case "$1 $2" in
  "is-enabled factory-api.service") echo "${FAKE_API_ENABLED:-disabled}"; [[ ${FAKE_API_ENABLED:-disabled} == enabled ]] ;;
  "is-active factory-api.service") echo "${FAKE_API_ACTIVE:-inactive}"; [[ ${FAKE_API_ACTIVE:-inactive} == active ]] ;;
  "is-active --quiet") exit 0 ;;
  "show factory-api.service") [[ -e $CONSOLE_CLEANUP_TEST_ROOT/etc/systemd/system/factory-api.service ]] && echo loaded || echo not-found ;;
  *) exit 0 ;;
esac""",
    "tailscale": 'echo "${FAKE_SERVE:-{\\}}"',
    "getent": """case $1 in
  passwd) if [[ $# == 1 ]]; then cat "$CONSOLE_CLEANUP_TEST_ROOT/fake-passwd"; else grep "^$2:" "$CONSOLE_CLEANUP_TEST_ROOT/fake-passwd"; fi ;;
  group) grep "^$2:" "$CONSOLE_CLEANUP_TEST_ROOT/fake-group" ;;
  *) exit 2 ;;
esac""",
    "pgrep": "exit 1",
    "findmnt": "echo /",
    "userdel": 'echo "userdel $*" >> "$CONSOLE_CLEANUP_TEST_ROOT/calls"',
    "groupdel": 'echo "groupdel $*" >> "$CONSOLE_CLEANUP_TEST_ROOT/calls"',
}


def make_db(path, rows, version=1):
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as db:
        db.executescript(f"PRAGMA journal_mode=WAL; PRAGMA user_version={version}; CREATE TABLE t(id INTEGER);")
        db.executemany("INSERT INTO t VALUES(?)", [(i,) for i in range(rows)])


def add_replica(directory, day):
    directory.mkdir(parents=True, exist_ok=True)
    name = f"{day}T031900.000000000Z.db.zst"
    with tempfile.TemporaryDirectory() as temp:
        source = pathlib.Path(temp) / "copy.db"
        with sqlite3.connect(source) as db:
            db.execute("CREATE TABLE t(id INTEGER)")
        subprocess.run(["zstd", "-q", str(source), "-o", str(directory / name)], check=True)
    digest = hashlib.sha256((directory / name).read_bytes()).hexdigest()
    (directory / f"{name}.sha256").write_text(f"{digest}  {name}\n")


class CleanupTest(unittest.TestCase):
    def setUp(self):
        self.assertNotEqual(os.geteuid(), 0, "Run fixture tests unprivileged")
        self.temp = tempfile.TemporaryDirectory()
        base = pathlib.Path(self.temp.name)
        self.root = r = base / "root"
        shims = base / "shims"
        shims.mkdir()
        for name, body in SHIMS.items():
            (shims / name).write_text(f"#!/usr/bin/env bash\n{body}\n")
            (shims / name).chmod(0o755)
        self.env = {**os.environ, "PATH": f"{shims}:{os.environ['PATH']}", "CONSOLE_CLEANUP_TEST_ROOT": str(r),
                    "BACKUP_HOST": "factory-console", "REPLICA_ROOT": str(r / "var/backups/factory-replica")}
        # Rollback artifacts.
        (r / "etc/systemd/system").mkdir(parents=True)
        (r / "etc/systemd/system/factory-api.service").write_text("[Unit]\n")
        (r / "usr/local/bin").mkdir(parents=True)
        (r / "usr/local/bin/factory-api").write_text("binary")
        make_db(r / "var/lib/factory-api/requests.db", 7, version=6)
        make_db(r / "var/lib/factory-api/pricing.db", 3)
        (r / "var/lib/factory-api/kiosk/assets").mkdir(parents=True)
        (r / "var/lib/factory-api/kiosk/index.html").write_text("old kiosk")
        (r / "var/backups/factory-api-move/console/bundle").mkdir(parents=True)
        (r / "var/backups/factory-api-move/console/bundle/requests.db.zst").write_text("x")
        for name in ("requests", "pricing"):
            add_replica(r / "var/backups/factory-db/factory-console" / name, "20261011")
        (r / "var/backups/factory-db/.backup.lock").write_text("")
        # Kept: replicas (7 daily new-layout days plus one pre-move day), autostart, config.
        self.replicas = r / "var/backups/factory-replica/factory-gpu"
        for name in ("meter", "requests", "pricing", "ups-control"):
            for day in ["20261011"] + [f"202610{d}" for d in range(17, 24)]:
                add_replica(self.replicas / name, day)
        (r / "home/console/.config/autostart").mkdir(parents=True)
        (r / "home/console/.config/autostart/console-kiosk.desktop").write_text("Exec=chrome\n")
        (r / "etc/factory-backup").mkdir(parents=True)
        (r / "etc/factory-backup/nodes.conf").write_text("# config\n")
        lib = r / "usr/local/lib/factory-backup"
        lib.mkdir(parents=True)
        for file in ("restore-check.sh", "nodes.conf"):
            (lib / file).write_bytes((here / "backup" / file).read_bytes())
        (lib / "restore-check.sh").chmod(0o755)
        # Uid/gid that own nothing in the fake root unless a test makes them.
        (r / "fake-passwd").write_text("factory-api:x:59997:59973::/var/lib/factory-api:/usr/sbin/nologin\n")
        (r / "fake-group").write_text("factory-api:x:59973:\n")

    def tearDown(self):
        self.temp.cleanup()

    def run_script(self, mode, success=True, **env):
        result = subprocess.run(["bash", str(SCRIPT), mode], env={**self.env, **env},
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def snapshot(self):
        return {p.relative_to(self.root): p.read_bytes() if p.is_file() else None for p in sorted(self.root.rglob("*"))
                if p.name != "calls"}

    def kept_tree(self):
        return {p: v for p, v in self.snapshot().items()
                if str(p).startswith(("var/backups/factory-replica", "home/", "etc/factory-backup", "usr/local/lib"))}

    def test_dry_run_lists_plan_and_changes_nothing(self):
        before = self.snapshot()
        out = self.run_script("--dry-run")
        self.assertEqual(before, self.snapshot())
        for path in ("etc/systemd/system/factory-api.service", "usr/local/bin/factory-api",
                     "var/lib/factory-api/requests.db", "var/lib/factory-api/kiosk/index.html",
                     "var/backups/factory-api-move/console/bundle/requests.db.zst",
                     "var/backups/factory-db/factory-console/pricing/20261011T031900.000000000Z.db.zst"):
            self.assertIn(f"{self.root}/{path}\n", out)
        self.assertIn("meter has 7 daily new-layout replicas (20261017..20261023)", out)
        self.assertIn("will remove the user and its group", out)
        self.assertNotIn(f"{self.replicas}/meter/", out.split("Never touched:")[0].split("Will delete")[1])
        self.assertIn("Dry run: nothing changed.", out)

    def test_apply_archives_then_deletes_only_listed_paths(self):
        kept = self.kept_tree()
        out = self.run_script("--apply")
        self.assertEqual(kept, self.kept_tree())
        r = self.root
        for path in ("etc/systemd/system/factory-api.service", "usr/local/bin/factory-api", "var/lib/factory-api",
                     "var/backups/factory-api-move", "var/backups/factory-db/factory-console/requests",
                     "var/backups/factory-db/factory-console/pricing"):
            self.assertFalse((r / path).exists(), path)
        # The backup tree root stays: install-backup's access check needs it.
        self.assertTrue((r / "var/backups/factory-db/factory-console").is_dir())
        self.assertTrue((r / "var/backups/factory-db/.backup.lock").is_file())
        archive = r / "var/backups/factory-met-118/archive"
        self.assertTrue((archive / "complete").is_file())
        restored = archive.parent / "restored.db"
        subprocess.run(["zstd", "-q", "-d", str(archive / "requests.db.zst"), "-o", str(restored)], check=True)
        with sqlite3.connect(restored) as db:
            self.assertEqual(db.execute("SELECT count(*), max(id) FROM t").fetchone(), (7, 6))
            self.assertEqual(db.execute("PRAGMA user_version").fetchone(), (6,))
        restored.unlink()
        self.assertIn("userdel factory-api", (r / "calls").read_text())
        self.assertIn("Cleanup complete", out)
        self.assertIn("Verified: MET-118", self.run_script("--verify"))
        # Rerun after success is a no-op that reuses the archive.
        self.assertIn("Nothing left to delete.", self.run_script("--apply"))

    def test_gate_refuses_with_six_new_layout_days(self):
        for copy in (self.replicas / "pricing").glob("20261023T*"):
            copy.unlink()
        before = self.snapshot()
        out = self.run_script("--apply", success=False)
        self.assertIn("only 6 daily new-layout pricing replicas", out)
        self.assertEqual(before, self.snapshot())

    def test_gate_refuses_corrupt_replica(self):
        copy = next((self.replicas / "meter").glob("20261019T*.db.zst"))
        copy.write_bytes(copy.read_bytes() + b"x")
        before = self.snapshot()
        self.assertIn("failed its checksum", self.run_script("--apply", success=False))
        self.assertEqual(before, self.snapshot())

    def test_refuses_when_rollback_is_in_effect(self):
        before = self.snapshot()
        self.assertIn("is enabled", self.run_script("--apply", success=False, FAKE_API_ENABLED="enabled"))
        self.assertIn("is active", self.run_script("--apply", success=False, FAKE_API_ACTIVE="active"))
        serve = '{"Web":{"x:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8080"}}}}}'
        self.assertIn("old API on :8080", self.run_script("--apply", success=False, FAKE_SERVE=serve))
        self.assertIn("not factory-console", self.run_script("--apply", success=False, FAKE_HOSTNAME="factory-gpu"))
        self.assertEqual(before, self.snapshot())

    def test_refuses_unlisted_entry_in_state_directory(self):
        (self.root / "var/lib/factory-api/notes.txt").write_text("keep me")
        before = self.snapshot()
        self.assertIn("Unexpected entry", self.run_script("--apply", success=False))
        self.assertEqual(before, self.snapshot())

    def test_keeps_account_while_group_has_members_or_owns_files(self):
        (self.root / "fake-group").write_text("factory-api:x:59973:factory-devices\n")
        out = self.run_script("--apply")
        self.assertIn("KEEP (not removed): group factory-api has members: factory-devices", out)
        self.assertNotIn("userdel", (self.root / "calls").read_text())
        # A file owned by the account's group outside the deleted paths also keeps it.
        gid = os.getgid()
        (self.root / "fake-group").write_text(f"factory-api:x:{gid}:\n")
        (self.root / "fake-passwd").write_text(f"factory-api:x:59997:{gid}::/var/lib/factory-api:/usr/sbin/nologin\n")
        self.assertIn("files still owned by factory-api", self.run_script("--dry-run"))


if __name__ == "__main__":
    unittest.main()
