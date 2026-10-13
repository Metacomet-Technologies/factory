#!/usr/bin/env python3
"""install-alerts.sh and rollback-alerts.sh against a fake root with stubbed systemd tools.

Tokens are synthetic; every run asserts that neither appears in the output.
"""

import os
import pathlib
import re
import subprocess
import tempfile
import unittest

here = pathlib.Path(__file__).resolve().parent
TOKEN = "xoxb-1234567890-abcdefghij"
ROTATED = "xoxb-1234567890-zyxwvutsrq"
STUBS = {
    "hostname": 'echo "$FAKE_HOSTNAME"',
    # Stateful enough for the installer: enable/start/stop flip marker files.
    "systemctl": r'''R=$ALERTS_TEST_ROOT
echo "systemctl $*" >> "$R/calls"
args=("$@") quiet=false
if [[ ${args[0]} == is-active && ${args[1]} == --quiet ]]; then quiet=true; args=(is-active "${args[@]:2}"); fi
case ${args[0]} in
    show) case "$*" in *LoadState*) echo loaded ;; *DropInPaths*) cat "$R/dropins" 2>/dev/null || true ;; esac ;;
    is-active) if [[ -e $R/active-${args[1]} ]]; then $quiet || echo active; else $quiet || echo inactive; exit 3; fi ;;
    is-enabled) if [[ -e $R/enabled-${args[1]} ]]; then echo enabled; else echo disabled; exit 1; fi ;;
    enable) touch "$R/enabled-${args[1]}" ;;
    disable) if [[ ${args[1]} == --now ]]; then rm -f "$R/enabled-${args[2]}" "$R/active-${args[2]}"; else rm -f "$R/enabled-${args[1]}"; fi ;;
    start|restart)
        if [[ ${args[1]} == factory-watchdog.service ]]; then [[ ! -e $R/watchdog-fail ]]; else touch "$R/active-${args[1]}"; fi ;;
    stop) rm -f "$R/active-${args[1]}" ;;
esac''',
    "journalctl": r'''echo "journalctl $*" >> "$ALERTS_TEST_ROOT/calls"
[[ -e $ALERTS_TEST_ROOT/journal-fail ]] || echo "alerts: Slack token loaded; posting enabled"''',
    "curl": 'echo "curl $*" >> "$ALERTS_TEST_ROOT/calls"',
    "systemd-run": 'echo "systemd-run $*" >> "$ALERTS_TEST_ROOT/calls"',
    "sleep": "true",
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
        (self.root / "active-factory-api.service").touch()
        self.token = self.root / "etc/factory-alerts/slack-token"
        self.dropin = self.root / "etc/systemd/system/factory-api.service.d/50-factory-alerts.conf"
        self.units = self.root / "etc/systemd/system"
        self.script = self.root / "usr/local/lib/factory-alerts/factory-watchdog.py"
        self.env = {**os.environ, "ALERTS_TEST_ROOT": str(self.root), "FAKE_HOSTNAME": "factory-gpu",
                    "PATH": f"{self.bin}:/usr/bin:/bin"}

    def tearDown(self):
        self.temp.cleanup()

    def run_script(self, script, *args, stdin=TOKEN + "\n", ok=True):
        (self.root / "calls").unlink(missing_ok=True)
        result = subprocess.run(["bash", str(here / script), *args], input=stdin, env=self.env,
                                capture_output=True, text=True, timeout=30)
        output = result.stdout + result.stderr
        for secret in (TOKEN, ROTATED):
            self.assertNotIn(secret, output)
        self.assertEqual(result.returncode == 0, ok, output)
        calls = (self.root / "calls").read_text() if (self.root / "calls").exists() else ""
        return output, calls

    def snapshot(self, output):
        match = re.search(r"^Snapshot \(root-only\): (\S+)$", output, re.M)
        self.assertIsNotNone(match, output)
        path = pathlib.Path(str(self.root) + match[1])
        self.assertEqual(self.mode(path), 0o700)
        return path

    def mode(self, path):
        return path.stat().st_mode & 0o777

    def install(self, node, stdin=TOKEN + "\n", ok=True):
        return self.run_script("install-alerts.sh", "--node", node, stdin=stdin, ok=ok)

    def test_gpu_install_rerun_rotate_and_rollback(self):
        output, calls = self.install("factory-gpu")
        first = self.snapshot(output)
        self.assertTrue((first / "slack-token.missing").exists() and (first / "factory-api-alerts.conf.missing").exists())
        self.assertEqual(self.token.read_text(), TOKEN + "\n")
        self.assertEqual((self.mode(self.token), self.mode(self.token.parent)), (0o600, 0o700))
        self.assertEqual(self.dropin.read_text(), (here / "factory-api-alerts.conf").read_text())
        self.assertIn("LoadCredential=slack-bot-token:/etc/factory-alerts/slack-token", self.dropin.read_text())
        self.assertEqual(calls.count("systemctl daemon-reload"), 1)
        self.assertEqual(calls.count("systemctl restart factory-api.service"), 1)
        self.assertIn("Slack token loaded", output)
        (self.root / "dropins").write_text("/etc/systemd/system/factory-api.service.d/50-factory-alerts.conf\n")
        output, calls = self.install("factory-gpu")
        self.assertIn("Nothing changed; no snapshot taken", output)
        self.assertNotIn("restart", calls)
        output, calls = self.install("factory-gpu", stdin=ROTATED)
        rotation = self.snapshot(output)
        self.assertEqual((rotation / "slack-token").read_text(), TOKEN + "\n")
        self.assertEqual(self.mode(rotation / "slack-token"), 0o600)
        self.assertEqual(self.token.read_text(), ROTATED + "\n")
        self.assertNotIn("daemon-reload", calls)
        self.assertEqual(calls.count("systemctl restart factory-api.service"), 1)
        self.assertEqual(list(self.token.parent.iterdir()), [self.token])
        # Rolling back the rotation restores the previous token and keeps the drop-in.
        _, calls = self.run_script("rollback-alerts.sh", "--node", "factory-gpu", str(rotation), stdin="")
        self.assertEqual(self.token.read_text(), TOKEN + "\n")
        self.assertTrue(self.dropin.exists())
        self.assertEqual(calls.count("systemctl restart factory-api.service"), 1)
        # Rolling back the first install removes everything, drop-in before restart.
        _, calls = self.run_script("rollback-alerts.sh", "--node", "factory-gpu", str(first), stdin="")
        self.assertFalse(self.dropin.parent.exists() or self.token.parent.exists())
        self.assertLess(calls.index("daemon-reload"), calls.index("restart factory-api.service"))

    def test_gpu_rotation_failure_restores_the_working_token(self):
        self.install("factory-gpu")
        (self.root / "journal-fail").touch()  # The restarted API never reports the token loaded.
        output, calls = self.install("factory-gpu", stdin=ROTATED, ok=False)
        self.assertIn("did not report the Slack token as loaded", output)
        self.assertIn("Previous token, files and service state restored.", output)
        self.assertEqual(self.token.read_text(), TOKEN + "\n")
        self.assertEqual(self.mode(self.token), 0o600)
        self.assertEqual(self.dropin.read_text(), (here / "factory-api-alerts.conf").read_text())
        # Restarted once with the new token and once more with the restored one.
        self.assertEqual(calls.count("systemctl restart factory-api.service"), 2)
        self.assertTrue((self.root / "active-factory-api.service").exists())
        self.assertEqual([p for p in (self.root / "var/backups/factory-alerts").iterdir() if p.name.startswith(".")], [])
        # The default no-snapshot rollback still removes everything.
        (self.root / "journal-fail").unlink()
        self.run_script("rollback-alerts.sh", "--node", "factory-gpu", stdin="")
        self.assertFalse(self.dropin.exists() or self.token.exists())

    def test_refusals_change_nothing(self):
        etc = self.root / "etc/factory-alerts"
        self.env["FAKE_HOSTNAME"] = "factory-console"
        output, _ = self.install("factory-gpu", ok=False)
        self.assertIn("not factory-gpu", output)
        self.env["FAKE_HOSTNAME"] = "factory-gpu"
        for bad in ["", "xoxp-1234567890-abcdefghij\n", "xoxb-short\n", TOKEN + " extra\n"]:
            output, _ = self.install("factory-gpu", stdin=bad, ok=False)
            self.assertIn("nothing changed", output)
        self.assertFalse(etc.exists())
        (self.root / "dropins").write_text("/etc/systemd/system/factory-api.service.d/override.conf\n")
        output, _ = self.install("factory-gpu", ok=False)
        self.assertIn("Unexpected factory-api drop-ins", output)
        (self.root / "dropins").unlink()
        (self.root / "usr/local/bin/factory-api").write_text("#!/usr/bin/env bash\necho old\n")
        output, _ = self.install("factory-gpu", ok=False)
        self.assertIn("predates MET-150", output)
        self.assertFalse(etc.exists() or (self.root / "var/backups/factory-alerts").exists())
        self.run_script("install-alerts.sh", "--node", "factory-mac", ok=False)

    def test_console_install_rerun_and_rollback(self):
        self.env["FAKE_HOSTNAME"] = "factory-console"
        output, calls = self.install("factory-console")
        first = self.snapshot(output)
        for name in ["factory-watchdog.service", "factory-watchdog.timer"]:
            self.assertEqual((self.units / name).read_text(), (here / name).read_text())
            self.assertEqual(self.mode(self.units / name), 0o644)
        self.assertEqual(self.script.read_text(), (here / "factory-watchdog.py").read_text())
        self.assertFalse((self.units / "factory-api.service.d").exists())
        self.assertIn("systemctl enable factory-watchdog.timer", calls)
        self.assertIn("systemctl start factory-watchdog.timer", calls)
        self.assertIn("systemctl start factory-watchdog.service", calls)
        output, calls = self.install("factory-console")
        self.assertIn("Nothing changed", output)
        self.assertNotIn("daemon-reload", calls)
        self.assertNotIn("restart", calls)
        _, calls = self.run_script("install-alerts.sh", "--node", "factory-console", "--test-alert", stdin="")
        self.assertIn("LoadCredential=slack-bot-token:/etc/factory-alerts/slack-token", calls)
        self.assertIn("factory-watchdog.py --test-alert", calls)
        _, calls = self.run_script("rollback-alerts.sh", "--node", "factory-console", str(first), stdin="")
        self.assertIn("systemctl disable --now factory-watchdog.timer", calls)
        self.assertIn("systemctl clean --what=state factory-watchdog.service", calls)
        self.assertFalse(self.script.parent.exists() or (self.units / "factory-watchdog.timer").exists())
        self.assertFalse((self.root / "etc/factory-alerts").exists())

    def test_console_update_failure_restores_previous_files_and_timer(self):
        self.env["FAKE_HOSTNAME"] = "factory-console"
        self.install("factory-console")
        # An older deployed watchdog, then an update with a rotated token whose first run fails.
        self.script.write_text("# previous watchdog\n")
        (self.root / "watchdog-fail").touch()
        output, calls = self.install("factory-console", stdin=ROTATED, ok=False)
        self.assertIn("The first watchdog run failed.", output)
        self.assertIn("Previous token, files and service state restored.", output)
        self.assertEqual(self.token.read_text(), TOKEN + "\n")
        self.assertEqual(self.script.read_text(), "# previous watchdog\n")
        self.assertEqual(self.mode(self.script), 0o755)
        self.assertTrue((self.units / "factory-watchdog.timer").exists())
        self.assertTrue((self.root / "enabled-factory-watchdog.timer").exists())
        self.assertTrue((self.root / "active-factory-watchdog.timer").exists())
        self.assertNotIn("clean --what=state", calls)


if __name__ == "__main__":
    unittest.main()
