#!/usr/bin/env python3
"""Unprivileged installer and rollback tests with a fake root and PATH shims.

No sudo, no real users, units, tokens or smartctl.
"""

import grp
import os
import pathlib
import stat
import subprocess
import tempfile
import unittest

here = pathlib.Path(__file__).resolve().parent
TOKEN = "fdv1_" + "Ab3-_" * 8 + "xyz"
assert len(TOKEN) == 48

SHIMS = {
    "hostname": 'echo "$FAKE_HOSTNAME"',
    "systemctl": 'echo "systemctl $*" >> "$DEVICES_AGENT_TEST_ROOT/calls"',
    "getent": """case $1 in
  passwd) grep "^$2:" "$DEVICES_AGENT_TEST_ROOT/fake-passwd" 2>/dev/null ;;
  group) grep "^$2:" "$DEVICES_AGENT_TEST_ROOT/fake-group" 2>/dev/null ;;
  *) exit 2 ;;
esac""",
    "groupadd": 'echo "groupadd $*" >> "$DEVICES_AGENT_TEST_ROOT/calls"; '
    'echo "${@: -1}:x:998:" >> "$DEVICES_AGENT_TEST_ROOT/fake-group"',
    "useradd": 'echo "useradd $*" >> "$DEVICES_AGENT_TEST_ROOT/calls"; '
    'echo "${@: -1}:x:998:998::/nonexistent:/usr/sbin/nologin" >> "$DEVICES_AGENT_TEST_ROOT/fake-passwd"',
    "usermod": 'echo "usermod $*" >> "$DEVICES_AGENT_TEST_ROOT/calls"; '
    'echo "$2" >> "$DEVICES_AGENT_TEST_ROOT/fake-members"',
    "id": 'echo factory-devices $(cat "$DEVICES_AGENT_TEST_ROOT/fake-members" 2>/dev/null)',
    "smartctl": "exit 0",
}


def member_group():
    extra = [g for g in os.getgroups() if g != os.getgid()]
    return grp.getgrgid(extra[0]) if extra else None


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.assertNotEqual(os.geteuid(), 0, "Run fixture tests unprivileged")
        self.temp = tempfile.TemporaryDirectory()
        base = pathlib.Path(self.temp.name)
        self.root = base / "root"
        self.bin = base / "bin"
        self.root.mkdir()
        self.bin.mkdir()
        for name, body in SHIMS.items():
            path = self.bin / name
            path.write_text(f"#!/bin/bash\n{body}\n")
            path.chmod(0o755)
        self.agent = base / "factory-devices-agent"
        # Never executed by the installer: an ELF header and the crate's name.
        self.agent.write_bytes(b"\x7fELF" + b"\0" * 60 + b"factory_devices_agent\n")
        self.agent.chmod(0o755)
        # factory-api state that must never be touched.
        self.api_tokens = self.root / "etc/factory-api/device-tokens"
        self.api_tokens.parent.mkdir(parents=True)
        self.api_tokens.write_text("factory-console abc label\n")
        self.env = os.environ.copy()
        self.env.update(
            DEVICES_AGENT_TEST_ROOT=str(self.root),
            FAKE_HOSTNAME="factory-console",
            PATH=f"{self.bin}:{self.env.get('PATH', '')}",
        )

    def tearDown(self):
        self.temp.cleanup()

    def run_script(self, name, *args, stdin=""):
        return subprocess.run(
            ["bash", str(here / name), *args],
            env=self.env,
            input=stdin,
            text=True,
            capture_output=True,
            check=False,
        )

    def install(self, *args, stdin=TOKEN + "\n"):
        return self.run_script("install-devices-agent.sh", str(self.agent), *args, stdin=stdin)

    def calls(self):
        path = self.root / "calls"
        return path.read_text() if path.exists() else ""

    def mode(self, rel):
        return stat.S_IMODE((self.root / rel).stat().st_mode)

    def test_refuses_any_other_host(self):
        self.env["FAKE_HOSTNAME"] = "factory-gpu"
        for args in ((), ("--check-only",)):
            result = self.install(*args)
            self.assertEqual(result.returncode, 1)
            self.assertIn("not factory-console; nothing changed", result.stderr)
        self.assertFalse((self.root / "usr").exists())
        self.assertFalse((self.root / "etc/factory-devices-agent").exists())
        self.assertEqual(self.calls(), "")

    def test_check_only_reads_no_stdin_and_changes_nothing(self):
        result = self.install("--check-only")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Host factory-console, binary sha256 ", result.stdout)
        self.assertIn("User factory-devices will be created.", result.stdout)
        self.assertIn("Will install: /usr/local/bin/factory-devices-agent", result.stdout)
        self.assertIn("Token file is missing", result.stdout)
        self.assertIn("Not published: ", result.stderr)
        self.assertIn("nothing changed, stdin not read", result.stdout)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["etc"])
        self.assertEqual(self.calls(), "")

    def test_install_is_idempotent_and_never_prints_the_token(self):
        first = self.install()
        self.assertEqual(first.returncode, 0, first.stderr)
        output = first.stdout + first.stderr
        self.assertNotIn(TOKEN, output)
        self.assertIn("Token written.", output)
        token = self.root / "etc/factory-devices-agent/token"
        self.assertEqual(token.read_text(), TOKEN + "\n")
        self.assertEqual(self.mode("etc/factory-devices-agent/token"), 0o600)
        self.assertEqual(self.mode("etc/factory-devices-agent"), 0o700)
        self.assertEqual(self.mode("usr/local/bin/factory-devices-agent"), 0o755)
        self.assertEqual(self.mode("var/lib/factory-devices"), 0o2750)
        pairs = {
            "etc/systemd/system/factory-devices-agent.service": here / "factory-devices-agent.service",
            "usr/local/lib/factory-devices/smart-snapshot.py": here / "../devices/smart-snapshot.py",
            "etc/systemd/system/factory-devices-smart.timer": here / "../devices/factory-devices-smart.timer",
            "etc/systemd/system/factory-devices-smart.service.d/console.conf": here / "smart-console.conf",
        }
        for rel, source in pairs.items():
            self.assertEqual((self.root / rel).read_bytes(), source.read_bytes(), rel)
        calls = self.calls()
        self.assertIn("groupadd --system factory-devices", calls)
        self.assertIn("useradd --system --gid factory-devices", calls)
        self.assertIn("--shell /usr/sbin/nologin", calls)
        self.assertIn("systemctl enable --now factory-devices-smart.timer", calls)
        self.assertIn("systemctl restart factory-devices-agent.service", calls)
        self.assertNotIn("smartctl", calls)

        second = self.install(stdin="")
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(token.read_text(), TOKEN + "\n")
        third = self.install()
        self.assertEqual(third.returncode, 0, third.stderr)
        self.assertIn("Token unchanged.", third.stdout)
        self.assertEqual(self.calls().count("useradd"), 1)
        self.assertEqual(self.calls().count("groupadd"), 1)
        check = self.install("--check-only")
        self.assertNotIn("Will install", check.stdout)
        self.assertIn("Token file exists:", check.stdout)
        self.assertIn("User factory-devices exists.", check.stdout)
        self.assertEqual(self.api_tokens.read_text(), "factory-console abc label\n")

    def test_bad_or_missing_token_changes_nothing(self):
        for stdin, message in (
            ("fdv1_short\n", "not an fdv1_ token"),
            ("", "No token on stdin"),
        ):
            result = self.install(stdin=stdin)
            self.assertEqual(result.returncode, 1)
            self.assertIn(message, result.stderr)
            self.assertNotIn("fdv1_short", result.stdout + result.stderr)
        self.assertFalse((self.root / "etc/factory-devices-agent").exists())
        self.assertFalse((self.root / "usr").exists())
        self.assertEqual(self.calls(), "")

    def test_refuses_a_binary_that_is_not_the_agent(self):
        for body in (b"#!/bin/sh\necho factory_devices_agent\n", b"\x7fELF" + b"\0" * 60):
            self.agent.write_bytes(body)
            result = self.install("--check-only")
            self.assertEqual(result.returncode, 1)
            self.assertRegex(result.stderr, "Not an ELF binary|Not the devices agent")

    def test_existing_login_user_is_refused(self):
        (self.root / "fake-passwd").write_text("factory-devices:x:1001:1001::/home/x:/bin/bash\n")
        result = self.install()
        self.assertEqual(result.returncode, 1)
        self.assertIn("is not a system user", result.stderr)

    def test_group_only_for_read_only_published_status(self):
        group = member_group()
        if group is None:
            self.skipTest("needs a supplementary group")
        status = self.root / "var/lib/factory-reboot-status/status.json"
        status.parent.mkdir(parents=True)
        status.write_text("{}")
        os.chown(status.parent, -1, group.gr_gid)
        os.chown(status, -1, group.gr_gid)
        status.parent.chmod(0o750)
        status.chmod(0o660)
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("not published read-only", result.stderr)
        self.assertNotIn("usermod", self.calls())
        status.chmod(0o640)
        check = self.install("--check-only")
        self.assertIn(f"Will grant read-only group: {group.gr_name}", check.stdout)
        result = self.install(stdin="")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"usermod -aG {group.gr_name} factory-devices", self.calls())
        again = self.install(stdin="")
        self.assertIn(f"Already in read-only group {group.gr_name}.", again.stdout)
        self.assertEqual(self.calls().count("usermod"), 1)

    def test_rollback_removes_agent_restores_smart_and_keeps_token(self):
        smart = self.root / "usr/local/lib/factory-devices/smart-snapshot.py"
        smart.parent.mkdir(parents=True)
        smart.write_text("old helper\n")
        first = self.install()
        self.assertEqual(first.returncode, 0, first.stderr)
        snapshot = first.stdout.split("Backup: ")[1].split()[0]
        self.assertEqual(self.mode(pathlib.Path(snapshot).parent.relative_to(self.root)), 0o700)
        result = self.run_script("rollback-devices-agent.sh", snapshot)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / "usr/local/bin/factory-devices-agent").exists())
        self.assertFalse((self.root / "etc/systemd/system/factory-devices-agent.service").exists())
        self.assertFalse((self.root / "etc/systemd/system/factory-devices-smart.timer").exists())
        self.assertFalse((self.root / "etc/systemd/system/factory-devices-smart.service.d").exists())
        self.assertEqual(smart.read_text(), "old helper\n")
        self.assertTrue((self.root / "etc/factory-devices-agent/token").exists())
        calls = self.calls()
        self.assertIn("systemctl disable --now factory-devices-agent.service", calls)
        self.assertIn("systemctl disable --now factory-devices-smart.timer", calls)
        self.assertNotIn("factory-api", calls)
        self.assertEqual(self.api_tokens.read_text(), "factory-console abc label\n")
        result = self.run_script("rollback-devices-agent.sh", snapshot, "--remove-token")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / "etc/factory-devices-agent").exists())
        self.env["FAKE_HOSTNAME"] = "factory-gpu"
        refused = self.run_script("rollback-devices-agent.sh", snapshot)
        self.assertEqual(refused.returncode, 1)

    def test_unit_is_hardened_and_carries_no_secret(self):
        unit = (here / "factory-devices-agent.service").read_text()
        for line in (
            "User=factory-devices",
            "NoNewPrivileges=yes",
            "ProtectSystem=strict",
            "ProtectHome=yes",
            "PrivateTmp=yes",
            "LoadCredential=token:/etc/factory-devices-agent/token",
            "Restart=on-failure",
            "StartLimitBurst=5",
            "CapabilityBoundingSet=",
        ):
            self.assertIn(f"\n{line}\n", unit, line)
        self.assertNotIn("fdv1_", unit)
        self.assertNotIn("ReadWritePaths", unit)
        self.assertNotRegex(unit, r"\nProtectClock=")
        self.assertNotIn("Environment=FACTORY", unit)


if __name__ == "__main__":
    unittest.main()
