#!/usr/bin/env python3
"""install-alerts.sh and rollback-alerts.sh against a fake root with stubbed systemd tools."""

import os
import pathlib
import subprocess
import tempfile
import unittest

here = pathlib.Path(__file__).resolve().parent
TOKEN = "xoxb-1234567890-abcdefghij"
STUBS = {
    "hostname": 'echo "$FAKE_HOSTNAME"',
    "systemctl": r'''echo "systemctl $*" >> "$ALERTS_TEST_ROOT/calls"
case "$*" in
    *"--property=LoadState --value") echo loaded ;;
    *"--property=DropInPaths --value") cat "$ALERTS_TEST_ROOT/dropins" 2>/dev/null || true ;;
    "is-active --quiet"*) [[ -e "$ALERTS_TEST_ROOT/active" ]] ;;
esac''',
    "journalctl": 'echo "journalctl $*" >> "$ALERTS_TEST_ROOT/calls"; echo "alerts: Slack token loaded; posting enabled"',
    "curl": 'echo "curl $*" >> "$ALERTS_TEST_ROOT/calls"',
    "systemd-run": 'echo "systemd-run $*" >> "$ALERTS_TEST_ROOT/calls"',
}


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.assertNotEqual(os.geteuid(), 0, "Run fake-root tests unprivileged")
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name) / "root"
        self.bin = pathlib.Path(self.temp.name) / "bin"
        self.root.mkdir()
        self.bin.mkdir()
        for name, body in STUBS.items():
            (self.bin / name).write_text(f"#!/usr/bin/env bash\n{body}\n")
            (self.bin / name).chmod(0o755)
        api = self.root / "usr/local/bin/factory-api"
        api.parent.mkdir(parents=True)
        api.write_text("#!/usr/bin/env bash\necho '      --alerts-state <ALERTS_STATE>'\n")
        api.chmod(0o755)
        (self.root / "active").touch()
        self.env = {**os.environ, "ALERTS_TEST_ROOT": str(self.root), "FAKE_HOSTNAME": "factory-gpu",
                    "PATH": f"{self.bin}:/usr/bin:/bin"}

    def tearDown(self):
        self.temp.cleanup()

    def run_script(self, script, *args, stdin=TOKEN + "\n", ok=True):
        (self.root / "calls").unlink(missing_ok=True)
        result = subprocess.run(["bash", str(here / script), *args], input=stdin, env=self.env,
                                capture_output=True, text=True, timeout=30)
        output = result.stdout + result.stderr
        self.assertNotIn(TOKEN, output)
        self.assertEqual(result.returncode == 0, ok, output)
        calls = (self.root / "calls").read_text() if (self.root / "calls").exists() else ""
        return output, calls

    def mode(self, path):
        return path.stat().st_mode & 0o777

    def test_gpu_install_rerun_rotate_and_rollback(self):
        token = self.root / "etc/factory-alerts/slack-token"
        dropin = self.root / "etc/systemd/system/factory-api.service.d/50-factory-alerts.conf"
        output, calls = self.run_script("install-alerts.sh", "--node", "factory-gpu")
        self.assertEqual(token.read_text(), TOKEN + "\n")
        self.assertEqual((self.mode(token), self.mode(token.parent)), (0o600, 0o700))
        self.assertEqual(dropin.read_text(), (here / "factory-api-alerts.conf").read_text())
        self.assertIn("LoadCredential=slack-bot-token:/etc/factory-alerts/slack-token", dropin.read_text())
        self.assertEqual(calls.count("systemctl daemon-reload"), 1)
        self.assertEqual(calls.count("systemctl restart factory-api.service"), 1)
        self.assertIn("Slack token loaded", output)
        (self.root / "dropins").write_text("/etc/systemd/system/factory-api.service.d/50-factory-alerts.conf\n")
        output, calls = self.run_script("install-alerts.sh", "--node", "factory-gpu")
        self.assertIn("Nothing changed", output)
        self.assertNotIn("restart", calls)
        rotated = TOKEN.replace("abc", "xyz")
        _, calls = self.run_script("install-alerts.sh", "--node", "factory-gpu", stdin=rotated)
        self.assertEqual(token.read_text(), rotated + "\n")
        self.assertNotIn("daemon-reload", calls)
        self.assertEqual(calls.count("systemctl restart factory-api.service"), 1)
        self.assertEqual(list(token.parent.iterdir()), [token])
        _, calls = self.run_script("rollback-alerts.sh", "--node", "factory-gpu", stdin="")
        self.assertFalse(dropin.parent.exists() or token.parent.exists())
        self.assertLess(calls.index("daemon-reload"), calls.index("restart factory-api.service"))

    def test_refusals_change_nothing(self):
        etc = self.root / "etc/factory-alerts"
        self.env["FAKE_HOSTNAME"] = "factory-console"
        output, _ = self.run_script("install-alerts.sh", "--node", "factory-gpu", ok=False)
        self.assertIn("not factory-gpu", output)
        self.env["FAKE_HOSTNAME"] = "factory-gpu"
        for bad in ["", "xoxp-1234567890-abcdefghij\n", "xoxb-short\n", TOKEN + " extra\n"]:
            output, _ = self.run_script("install-alerts.sh", "--node", "factory-gpu", stdin=bad, ok=False)
            self.assertIn("nothing changed", output)
        self.assertFalse(etc.exists())
        (self.root / "dropins").write_text("/etc/systemd/system/factory-api.service.d/override.conf\n")
        output, _ = self.run_script("install-alerts.sh", "--node", "factory-gpu", ok=False)
        self.assertIn("Unexpected factory-api drop-ins", output)
        (self.root / "dropins").unlink()
        (self.root / "usr/local/bin/factory-api").write_text("#!/usr/bin/env bash\necho old\n")
        output, _ = self.run_script("install-alerts.sh", "--node", "factory-gpu", ok=False)
        self.assertIn("predates MET-150", output)
        self.assertFalse(etc.exists())
        self.run_script("install-alerts.sh", "--node", "factory-mac", ok=False)

    def test_console_install_rerun_and_rollback(self):
        self.env["FAKE_HOSTNAME"] = "factory-console"
        units = self.root / "etc/systemd/system"
        script = self.root / "usr/local/lib/factory-alerts/factory-watchdog.py"
        output, calls = self.run_script("install-alerts.sh", "--node", "factory-console")
        for name in ["factory-watchdog.service", "factory-watchdog.timer"]:
            self.assertEqual((units / name).read_text(), (here / name).read_text())
            self.assertEqual(self.mode(units / name), 0o644)
        self.assertEqual(script.read_text(), (here / "factory-watchdog.py").read_text())
        self.assertFalse((units / "factory-api.service.d").exists())
        self.assertIn("systemctl enable factory-watchdog.timer", calls)
        self.assertIn("systemctl restart factory-watchdog.timer", calls)
        self.assertIn("systemctl start factory-watchdog.service", calls)
        _, calls = self.run_script("install-alerts.sh", "--node", "factory-console")
        self.assertNotIn("daemon-reload", calls)
        self.assertNotIn("restart", calls)
        _, calls = self.run_script("install-alerts.sh", "--node", "factory-console", "--test-alert", stdin="")
        self.assertIn("LoadCredential=slack-bot-token:/etc/factory-alerts/slack-token", calls)
        self.assertIn("factory-watchdog.py --test-alert", calls)
        _, calls = self.run_script("rollback-alerts.sh", "--node", "factory-console", stdin="")
        self.assertIn("systemctl disable --now factory-watchdog.timer", calls)
        self.assertIn("systemctl clean --what=state factory-watchdog.service", calls)
        self.assertFalse(script.parent.exists() or (units / "factory-watchdog.timer").exists())
        self.assertFalse((self.root / "etc/factory-alerts").exists())


if __name__ == "__main__":
    unittest.main()
