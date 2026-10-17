#!/usr/bin/env python3
"""Unprivileged install, rollback, and SMART helper tests. No host smartctl."""

import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest

here = pathlib.Path(__file__).resolve().parent


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
