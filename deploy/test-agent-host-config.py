#!/usr/bin/env python3
"""Exercise the real prepare/rollback scripts in disposable unprivileged namespaces.

No host services, accounts, files or network are writable. Atuin's upstream
binary is tested separately; the installer fixture uses a local archive.
"""

from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


class HostConfigTest(unittest.TestCase):
    def setUp(self):
        if not shutil.which("bwrap"):
            self.skipTest("Bubblewrap is required for installer integration tests")
        probe = subprocess.run(["bwrap", "--unshare-user", "--uid", "0", "--ro-bind", "/", "/", "true"],
                               capture_output=True)
        if probe.returncode:
            self.skipTest("Unprivileged user namespaces unavailable")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for directory in ("etc/systemd/system", "etc/atuin", "usr/local/bin", "var/backups", "var/lib/atuin"):
            (self.root / directory).mkdir(parents=True, exist_ok=True)
        (self.root / "etc/passwd").write_text("root:x:0:0:root:/root:/bin/bash\n")
        (self.root / "etc/group").write_text("root:x:0:\n")
        (self.root / "etc/gitconfig").write_text("[core]\n pager = less\n")
        (self.root / "etc/environment").write_bytes(
            b'# preserve comment\nPATH="/usr/bin:/bin"\nPAGER=cat\n GIT_PAGER = cat\n'
            b'export SYSTEMD_PAGER=cat\nNO_COLOR=1\nOTHER_NO_COLOR=keep\nLAST=value')
        self.shim("hostname", 'echo "${TEST_HOST:-factory-gpu}"')
        self.shim("systemctl", '''echo "$*" >> /var/calls
case "$*" in
  *LoadState*) echo loaded ;;
  *ActiveState*) echo "${TEST_ACTIVE:-inactive}" ;;
  *MainPID*) echo "$TEST_PID" ;;
  *DropInPaths*) ;;
  daemon-reload|"is-active --quiet amp-runner.service") ;;
  *) exit 99 ;;
esac''')
        self.shim("tailscale", '[[ $* == "serve status" ]] || exit 98; echo "factory-api -> http://127.0.0.1:8080"')
        self.shim("systemd-analyze", '[[ $1 == verify ]]')
        self.shim("useradd", '''echo 'atuin:x:999:999::/var/lib/atuin:/usr/sbin/nologin' >> /etc/passwd
echo 'atuin:x:999:' >> /etc/group''')
        self.shim("curl", '''while [[ $# -gt 0 ]]; do
  if [[ $1 == -o ]]; then cp "$TEST_ARCHIVE" "$2"; exit; fi
  shift
done
exit 97''')
        self.shim("sha256sum", 'cat >/dev/null; [[ ${TEST_CHECKSUM:-ok} == ok ]]')
        artifact = self.root / "atuin-server-x86_64-unknown-linux-gnu"
        artifact.mkdir()
        binary = artifact / "atuin-server"
        binary.write_text('#!/bin/sh\necho "atuin-server 18.23.0"\n')
        binary.chmod(0o755)
        self.archive = self.root / "release.tar.gz"
        with tarfile.open(self.archive, "w:gz") as out:
            out.add(artifact, arcname=artifact.name)

    def shim(self, name, body):
        path = self.root / "usr/local/bin" / name
        path.write_text("#!/bin/bash\nset -euo pipefail\n" + body + "\n")
        path.chmod(0o755)

    def run_script(self, script, *args, color="1", **env):
        command = ["bwrap", "--unshare-all", "--uid", "0", "--gid", "0",
                   "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
                   "--bind", str(self.root / "etc"), "/etc",
                   "--bind", str(self.root / "var"), "/var",
                   "--bind", str(self.root / "usr/local/bin"), "/usr/local/bin"]
        # Installers which reset PATH still see the private /usr/local/bin shims.
        command += ["--setenv", "PATH", "/usr/local/bin:/usr/sbin:/usr/bin:/bin",
                    "--setenv", "NO_COLOR", color, "--setenv", "TEST_ARCHIVE", str(self.archive)]
        for key, value in env.items():
            command += ["--setenv", key, value]
        # The guard reads a real live process, with inherited NO_COLOR, inside /proc.
        command += ["bash", "-c", 'export TEST_PID=$$; exec bash "$@"', "fixture",
                    str(HERE / script), *args]
        return subprocess.run(command, text=True, capture_output=True, timeout=30)

    def success(self, script, *args, **env):
        result = self.run_script(script, *args, **env)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def snapshot(self, component):
        return next((self.root / f"var/backups/factory-{component}").glob("install.*"))

    def test_agent_dropin_install_rerun_and_rollback_on_both_nodes(self):
        target = self.root / "etc/systemd/system/amp-runner.service.d/agent-env.conf"
        for host in ("factory-gpu", "factory-console"):
            self.success("install-agent-env.sh", TEST_HOST=host)
            self.assertEqual(target.read_bytes(), (HERE / "amp-runner-agent-env.conf").read_bytes())
            initial = self.snapshot("agent-env")
            result = self.success("install-agent-env.sh", TEST_HOST=host)
            self.assertIn("Follow up explicitly, in order:", result.stdout)
            self.assertLess(result.stdout.index("systemctl restart amp-runner.service"),
                            result.stdout.index("NO_COLOR=1"))
            self.assertLess(result.stdout.index("NO_COLOR=1"),
                            result.stdout.index("rm /etc/factory/agent.env"))
            self.success("rollback-agent-env.sh", str(initial).replace(str(self.root), ""), TEST_HOST=host)
            self.assertFalse(target.exists())
            shutil.rmtree(self.root / "var/backups/factory-agent-env")
        self.assertTrue(all(line == "daemon-reload" or "LoadState" in line
                            for line in (self.root / "var/calls").read_text().splitlines()))

    def test_cleanup_refuses_wrong_live_color_and_restores_exact_file(self):
        path = self.root / "etc/environment"
        original = path.read_bytes()
        for color in ("", "0", "10"):
            result = self.run_script("install-environment-cleanup.sh", color=color)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("live amp-runner environment", result.stderr)
            self.assertEqual(path.read_bytes(), original)
            self.assertFalse((self.root / "var/backups/factory-environment").exists())
        for host in ("factory-gpu", "factory-console"):
            self.success("install-environment-cleanup.sh", TEST_HOST=host)
            self.assertEqual(path.read_bytes(), b'# preserve comment\nPATH="/usr/bin:/bin"\nOTHER_NO_COLOR=keep\nLAST=value')
            initial = self.snapshot("environment")
            self.success("install-environment-cleanup.sh", TEST_HOST=host)
            self.success("rollback-environment-cleanup.sh", str(initial).replace(str(self.root), ""), TEST_HOST=host)
            self.assertEqual(path.read_bytes(), original)
            shutil.rmtree(self.root / "var/backups/factory-environment")
        self.assertEqual((self.root / "etc/gitconfig").read_text(), "[core]\n pager = less\n")

    def test_atuin_checksum_refusal_prepare_and_rollback_preserve_data(self):
        binary = self.root / "usr/local/bin/atuin-server"
        binary.write_bytes(b"old binary")
        result = self.run_script("install-atuin-server.sh", TEST_CHECKSUM="bad")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(binary.read_bytes(), b"old binary")
        self.assertNotIn("atuin:", (self.root / "etc/passwd").read_text())
        shutil.rmtree(self.root / "var/backups/factory-atuin")
        self.success("install-atuin-server.sh")
        initial = self.snapshot("atuin")
        self.assertIn(b"18.23.0", binary.read_bytes())
        self.assertEqual((self.root / "etc/atuin/server.toml").read_bytes(), (HERE / "atuin-server.toml").read_bytes())
        data = self.root / "var/lib/atuin/atuin.db"
        data.write_bytes(b"precious encrypted history")
        result = self.run_script("install-atuin-server.sh", TEST_ACTIVE="active")
        self.assertNotEqual(result.returncode, 0)
        self.success("rollback-atuin-server.sh", str(initial).replace(str(self.root), ""))
        self.assertEqual(binary.read_bytes(), b"old binary")
        self.assertFalse((self.root / "etc/atuin/server.toml").exists())
        self.assertEqual(data.read_bytes(), b"precious encrypted history")
        self.assertIn("atuin:", (self.root / "etc/passwd").read_text())
        calls = (self.root / "var/calls").read_text()
        self.assertNotIn("start", calls)
        self.assertNotIn("stop", calls)


if __name__ == "__main__":
    unittest.main()
