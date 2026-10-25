#!/usr/bin/env python3
"""Run real runtime installers unprivileged, entirely below temporary roots.

Requires Python 3.11+ with venv/ensurepip and PyPI access. Two successful
installs and one rejected hash install use real pip; there are no fake venvs.
Run: python3 -B deploy/backup/test-offsite-runtime.py
"""

import hashlib
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest


HERE = Path(__file__).resolve().parent


def tree(path, *, timestamps=False):
    """Compare bytes, modes and link targets without following venv symlinks."""
    result = {}
    for entry in [path, *sorted(path.rglob("*"))]:
        info = entry.lstat()
        if entry.is_symlink():
            value = os.readlink(entry)
        elif entry.is_file():
            with entry.open("rb") as stream:
                value = hashlib.file_digest(stream, "sha256").hexdigest()
        else:
            value = None
        result[str(entry.relative_to(path))] = (
            stat.S_IMODE(info.st_mode), value,
            info.st_mtime_ns if timestamps else None,
        )
    return result


class RuntimeTest(unittest.TestCase):
    def setUp(self):
        self.assertNotEqual(os.geteuid(), 0, "Run these fixtures unprivileged")
        # Spaces exercise quoting, including the fd read used to lock /opt.
        self.temp = tempfile.TemporaryDirectory(prefix="offsite runtime ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.opt = self.root / "opt"
        self.opt.mkdir()
        self.runtime = self.opt / "factory-backup-r2"
        self.snapshots = self.opt / "factory-backup-r2-snapshots"
        self.artifact = self.root / "artifact"
        self.artifact.mkdir()
        for name in ("install-offsite-runtime.sh", "rollback-offsite-runtime.sh"):
            source = (HERE / name).read_text()
            self.assertEqual(source.count('[[ $EUID -eq 0 ]]'), 1)
            source = source.replace('[[ $EUID -eq 0 ]]', '[[ $EUID -ne 0 ]]')
            # Includes bare /opt in exec 9</opt and the rollback glob. Bash
            # concatenates these quoted prefixes with the original suffixes.
            source = source.replace('/opt', '"' + str(self.opt) + '"')
            (self.artifact / name).write_text(source)
        self.lock = self.artifact / "offsite-requirements.txt"
        shutil.copyfile(HERE / self.lock.name, self.lock)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name, body in {
            "install": '''args=()
while (($#)); do
    case "$1" in
        -o|-g) shift 2 ;;
        *) args+=("$1"); shift ;;
    esac
done
exec /usr/bin/install "${args[@]}"
''',
            "chown": "exit 0\n",
            "systemctl": "echo 'Unexpected live-unit command' >&2; exit 99\n",
            "sudo": "echo 'Unexpected sudo' >&2; exit 99\n",
        }.items():
            shim = self.bin / name
            shim.write_text("#!/bin/bash\nset -eu\n" + body)
            shim.chmod(0o755)
        # Keep all tool caches/home files disposable too. pip is isolated and
        # the real installer explicitly disables its download cache.
        self.env = dict(os.environ,
                        PATH=f"{self.bin}:{Path(sys.executable).parent}:/usr/bin:/bin",
                        HOME=str(self.root), TMPDIR=str(self.root))

    def run_script(self, name, *args, ok=True):
        result = subprocess.run(
            ["bash", str(self.artifact / name), *map(str, args)],
            env=self.env, capture_output=True, text=True, timeout=720,
        )
        output = result.stdout + result.stderr
        if ok:
            self.assertEqual(result.returncode, 0, output)
        else:
            self.assertNotEqual(result.returncode, 0, output)
        return output

    def install(self, **kwargs):
        return self.run_script("install-offsite-runtime.sh", **kwargs)

    def rollback(self, snapshot, **kwargs):
        return self.run_script("rollback-offsite-runtime.sh", snapshot, **kwargs)

    def snapshot_set(self):
        return set(self.snapshots.glob("install.*"))

    def new_snapshot(self, before):
        added = self.snapshot_set() - before
        self.assertEqual(len(added), 1)
        snapshot = added.pop()
        self.assertTrue((snapshot / "complete").is_file())
        return snapshot

    def test_real_install_upgrade_hash_failure_and_rollbacks(self):
        before = self.snapshot_set()
        self.assertIn("runtime ready", self.install())
        fresh = self.new_snapshot(before)
        self.assertTrue((fresh / "absent").is_file())
        self.assertFalse((fresh / "runtime").exists())
        self.assertEqual((self.runtime / "requirements.txt").read_bytes(),
                         self.lock.read_bytes())
        result = subprocess.run(
            [str(self.runtime / "bin/python"), "-I", "-c",
             'import boto3, pyrage, importlib.metadata as m; '
             'assert m.version("boto3") == "1.43.118"; '
             'assert m.version("pyrage") == "1.4.0"; '
             'print("boto3=" + m.version("boto3") + " pyrage=" + m.version("pyrage"))'],
            env=self.env, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        print(result.stdout.strip(), flush=True)

        unchanged = tree(self.runtime, timestamps=True)
        snapshots = self.snapshot_set()
        self.assertIn("already matches the lock; no changes", self.install())
        self.assertEqual(tree(self.runtime, timestamps=True), unchanged)
        self.assertEqual(self.snapshot_set(), snapshots)

        # An older lock forces the real upgrade branch without needing another
        # set of historical wheels. Snapshot/restore must preserve all bytes,
        # including administrator files, not just the requirements marker.
        marker = self.runtime / "requirements.txt"
        marker.write_bytes(marker.read_bytes() + b"\n# previous runtime lock\n")
        (self.runtime / "administrator-file").write_bytes(b"prior bytes\x00\xff")
        previous = tree(self.runtime)
        self.install()
        upgrade = self.new_snapshot(snapshots)
        self.assertEqual(tree(upgrade / "runtime"), previous)
        self.assertFalse((self.runtime / "administrator-file").exists())
        self.assertEqual(marker.read_bytes(), self.lock.read_bytes())
        for _ in range(2):
            self.rollback(upgrade)
            self.assertEqual(tree(self.runtime), previous)

        # Corrupt both allowed boto3 hashes so this exercises pip's actual
        # --require-hashes rejection, not a mocked subprocess failure.
        text = self.lock.read_text()
        first, rest = text.split("botocore==", 1)
        first, count = re.subn(r"sha256:[0-9a-f]{64}", "sha256:" + "0" * 64, first)
        self.assertEqual(count, 2)
        self.lock.write_text(first + "botocore==" + rest)
        snapshots = self.snapshot_set()
        output = self.install(ok=False)
        self.assertIn("DO NOT MATCH THE HASHES", output)
        failed = self.new_snapshot(snapshots)
        self.assertFalse(marker.exists(), "A failed install published its ready marker")
        self.assertEqual(tree(failed / "runtime"), previous)
        for _ in range(2):
            self.rollback(failed)
            self.assertEqual(tree(self.runtime), previous)

        for _ in range(2):
            self.rollback(fresh)
            self.assertFalse(self.runtime.exists())
        self.assertTrue((failed / "runtime/administrator-file").exists())

    def test_install_refuses_symlinks_before_mutation(self):
        target = self.root / "untouched"
        target.mkdir()
        (target / "keep").write_bytes(b"do not change")
        for destination in (self.runtime, self.snapshots):
            with self.subTest(destination=destination.name):
                destination.symlink_to(target, target_is_directory=True)
                before = tree(target, timestamps=True)
                self.assertIn("Refusing symlink", self.install(ok=False))
                self.assertEqual(tree(target, timestamps=True), before)
                self.assertTrue(destination.is_symlink())
                destination.unlink()
        # The parent directory is also guarded (and is the actual lock target).
        self.opt.rmdir()
        self.opt.symlink_to(target, target_is_directory=True)
        self.assertIn("Refusing symlink", self.install(ok=False))
        self.assertEqual((target / "keep").read_bytes(), b"do not change")

    def test_rollback_refuses_symlinks_and_incomplete_snapshots(self):
        self.snapshots.mkdir()
        snapshot = self.snapshots / "install.fixture"
        snapshot.mkdir()
        self.runtime.mkdir()
        (self.runtime / "keep").write_bytes(b"current runtime")
        before = tree(self.runtime, timestamps=True)
        self.assertIn("Invalid or incomplete snapshot", self.rollback(snapshot, ok=False))
        (snapshot / "complete").touch()
        self.assertIn("Invalid snapshot contents", self.rollback(snapshot, ok=False))
        (snapshot / "absent").touch()
        target = self.root / "untouched"
        self.runtime.rename(target)
        self.runtime.symlink_to(target, target_is_directory=True)
        self.assertIn("Refusing symlink", self.rollback(snapshot, ok=False))
        self.assertEqual(tree(target, timestamps=True), before)
        self.runtime.unlink()
        target.rename(self.runtime)
        (snapshot / "absent").unlink()
        (snapshot / "runtime").symlink_to(self.runtime, target_is_directory=True)
        self.assertIn("Refusing symlink", self.rollback(snapshot, ok=False))
        self.assertEqual(tree(self.runtime, timestamps=True), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
