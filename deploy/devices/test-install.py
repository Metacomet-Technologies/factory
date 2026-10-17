#!/usr/bin/env python3
"""Unprivileged install, rollback, and SMART helper tests. No host smartctl."""

import contextlib
import grp
import importlib.util
import io
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest

here = pathlib.Path(__file__).resolve().parent


def member_group():
    extra = [group for group in os.getgroups() if group != os.getgid()]
    if not extra:
        raise AssertionError("need a supplementary group to prove snapshot chown")
    return grp.getgrgid(extra[0])


def load_helper():
    spec = importlib.util.spec_from_file_location("smart_snapshot", here / "smart-snapshot.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.assertNotEqual(os.geteuid(), 0, "Run fake-root tests unprivileged")
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name) / "root"
        self.bin = pathlib.Path(self.temp.name) / "bin"
        self.root.mkdir()
        self.bin.mkdir()
        (self.bin / "hostname").write_text('#!/bin/sh\necho "$FAKE_HOSTNAME"\n')
        (self.bin / "systemctl").write_text(
            '#!/bin/sh\necho "$*" >> "$DEVICES_TEST_ROOT/calls"\n'
        )
        for name in ("hostname", "systemctl"):
            (self.bin / name).chmod(0o755)
        self.env = os.environ.copy()
        self.env["DEVICES_TEST_ROOT"] = str(self.root)
        self.env["FAKE_HOSTNAME"] = "factory-gpu"
        self.env["PATH"] = f"{self.bin}:{self.env.get('PATH', '')}"

    def tearDown(self):
        self.temp.cleanup()

    def run_install(self, *args):
        return subprocess.run(
            ["bash", str(here / "install-devices.sh"), *args],
            env=self.env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_install_is_idempotent_and_does_not_call_smartctl(self):
        first = self.run_install()
        self.assertEqual(first.returncode, 0, first.stderr)
        helper = self.root / "usr/local/lib/factory-devices/smart-snapshot.py"
        self.assertEqual(helper.read_bytes(), (here / "smart-snapshot.py").read_bytes())
        mode = stat.S_IMODE((self.root / "var/lib/factory-devices").stat().st_mode)
        self.assertEqual(mode, 0o750)
        second = self.run_install()
        self.assertEqual(second.returncode, 0, second.stderr)
        calls = (self.root / "calls").read_text()
        self.assertNotIn("smartctl", calls)
        self.assertIn("enable --now factory-devices-smart.timer", calls)
        preflight = self.run_install("--preflight")
        self.assertEqual(preflight.returncode, 0, preflight.stderr)
        self.assertIn("group-readable copy", preflight.stdout)

    def test_reinstall_restores_setgid_directory_and_snapshot_group(self):
        group = member_group()
        self.env["DEVICES_TEST_GROUP"] = group.gr_name
        first = self.run_install()
        self.assertEqual(first.returncode, 0, first.stderr)
        state = self.root / "var/lib/factory-devices"
        snapshot = state / "smart.json"
        self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o2750)
        self.assertEqual(state.stat().st_gid, group.gr_gid)
        snapshot.write_text('{"previous": true}\n')
        os.chown(snapshot, -1, os.getgid())
        os.chmod(snapshot, 0o600)
        os.chown(state, -1, os.getgid())
        os.chmod(state, 0o750)
        second = self.run_install()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o2750)
        self.assertEqual(state.stat().st_gid, group.gr_gid)
        self.assertEqual(snapshot.stat().st_gid, group.gr_gid)
        self.assertEqual(stat.S_IMODE(snapshot.stat().st_mode), 0o640)
        self.assertEqual(snapshot.read_text(), '{"previous": true}\n')

    def test_publish_assigns_group_before_replace(self):
        module = load_helper()
        directory = pathlib.Path(self.temp.name) / "publish"
        directory.mkdir()
        os.chmod(directory, 0o750)
        destination = directory / "smart.json"
        group = member_group()
        module.write_snapshot(destination, {"drives": [], "tool": "absent"}, group.gr_gid)
        self.assertEqual(destination.stat().st_gid, group.gr_gid)
        self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o640)
        module.write_snapshot(
            destination, {"drives": [{"kernel": "nvme0n1"}], "observed_at_ms": 1}, group.gr_gid
        )
        self.assertEqual(destination.stat().st_gid, group.gr_gid)
        self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o640)
        self.assertEqual(json.loads(destination.read_text())["drives"][0]["kernel"], "nvme0n1")
        self.assertEqual(list(directory.iterdir()), [destination])

    def test_chown_failure_does_not_replace_the_live_snapshot(self):
        module = load_helper()
        directory = pathlib.Path(self.temp.name) / "publish-fail"
        directory.mkdir()
        destination = directory / "smart.json"
        destination.write_text('{"previous": true}\n')
        os.chmod(destination, 0o640)
        with self.assertRaises(PermissionError):
            module.write_snapshot(destination, {"drives": [], "tool": "absent"}, 0)
        self.assertEqual(destination.read_text(), '{"previous": true}\n')
        self.assertEqual(destination.stat().st_gid, os.getgid())
        self.assertEqual(list(directory.iterdir()), [destination])
        missing = directory / "fresh.json"
        with self.assertRaises(PermissionError):
            module.write_snapshot(missing, {"drives": []}, 0)
        self.assertFalse(missing.exists())
        self.assertEqual(list(directory.iterdir()), [destination])

    def test_missing_publish_group_fails_before_a_root_snapshot(self):
        module = load_helper()
        self.assertIsNone(module.publish_group())
        error = io.StringIO()
        with contextlib.redirect_stderr(error), self.assertRaises(SystemExit) as caught:
            module.require_group("no-such-factory-api-group")
        self.assertEqual(caught.exception.code, 1)
        self.assertIn("no-such-factory-api-group group is missing", error.getvalue())

    def test_rollback_restores_the_previous_helper(self):
        helper = self.root / "usr/local/lib/factory-devices/smart-snapshot.py"
        helper.parent.mkdir(parents=True)
        helper.write_text("previous\n")
        installed = self.run_install()
        self.assertEqual(installed.returncode, 0, installed.stderr)
        snapshot = installed.stdout.strip().split()[-1]
        self.assertNotEqual(helper.read_text(), "previous\n")
        rolled = subprocess.run(
            ["bash", str(here / "rollback-devices.sh"), snapshot],
            env=self.env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(rolled.returncode, 0, rolled.stderr)
        self.assertEqual(helper.read_text(), "previous\n")

    def test_helper_sanitizes_smartctl_output_and_reports_an_absent_tool(self):
        fixture = pathlib.Path(self.temp.name) / "fixture"
        (fixture / "sys/block/nvme0n1").mkdir(parents=True)
        (fixture / "sys/block/nvme0n1/partition").unlink(missing_ok=True)
        stub = self.bin / "smartctl"
        stub.write_text(
            "#!/usr/bin/python3\n"
            "import json, sys\n"
            "json.dump({"
            "'smart_status': {'passed': True},"
            "'nvme_smart_health_information_log': {"
            "'available_spare': 100, 'available_spare_threshold': 10,"
            "'media_errors': 0, 'temperature': 34},"
            "'secret': 'do-not-keep', 'argv': ['hidden']"
            "}, sys.stdout)\n"
        )
        stub.chmod(0o755)
        env = self.env.copy()
        env["FACTORY_DEVICES_ROOT"] = str(fixture)
        env["PATH"] = str(self.bin)
        result = subprocess.run(
            [sys.executable, str(here / "smart-snapshot.py")],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads((fixture / "var/lib/factory-devices/smart.json").read_text())
        self.assertNotIn("secret", json.dumps(payload))
        self.assertEqual(payload["drives"][0]["passed"], True)
        self.assertEqual(payload["drives"][0]["kernel"], "nvme0n1")
        stub.unlink()
        result = subprocess.run(
            [sys.executable, str(here / "smart-snapshot.py")],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        absent = json.loads((fixture / "var/lib/factory-devices/smart.json").read_text())
        self.assertEqual(absent["tool"], "absent")


if __name__ == "__main__":
    unittest.main()
