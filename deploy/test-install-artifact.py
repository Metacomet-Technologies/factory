#!/usr/bin/env python3
"""MET-239: installers refuse artifacts not built from their clean checkout.

ArtifactCheckTest: unprivileged, with PATH shims for sudo and git. The check
runs before the root check, so a refusal that never reaches "Run as root" also
changed nothing.

FakeRootCheckOnlyTest: the real --check-only path of each installer with real
artifacts built at HEAD (target/release, kiosk/dist), as uid 0 inside an
unprivileged Bubblewrap user namespace. Deployment paths are disposable tmpfs
mounts and system services are shims, so no host state can change.
"""

import json
import os
import pathlib
import subprocess
import tempfile
import unittest

here = pathlib.Path(__file__).resolve().parent
HEAD = "abc1234"

# sudo -u agent CMD...: answer --build-info from the fixture, else run CMD.
SUDO = """echo "sudo $*" >> "$ARTIFACT_TEST_CALLS"
[[ $1 == -u && $2 == agent ]] || exit 99
shift 2
if [[ ${*: -1} == --build-info ]]; then
    [[ -n ${FAKE_BUILD_INFO_FAIL:-} ]] && { echo "error: unexpected argument '--build-info'" >&2; exit 2; }
    printf '%s\\n' "$FAKE_BUILD_INFO"
    exit 0
fi
exec "$@"
"""
GIT = """case $3 in
  rev-parse) echo "$FAKE_HEAD" ;;
  status) printf '%s' "$FAKE_STATUS" ;;
  *) exit 98 ;;
esac
"""

REFUSALS = {
    "mismatch": ({"git_sha": "def5678", "git_dirty": False}, "", f"built at def5678 but checkout .* is at {HEAD}"),
    "dirty build": ({"git_sha": HEAD, "git_dirty": True}, "", "built from a dirty tree"),
    "unknown sha": ({"git_sha": "unknown", "git_dirty": False}, "", "no build SHA"),
    "missing sha": ({"git_dirty": False}, "", "no build SHA"),
    "missing dirty": ({"git_sha": HEAD}, "", "dirty tree \\(git_dirty: null\\)"),
    "dirty checkout": ({"git_sha": HEAD, "git_dirty": False}, " M kiosk/src/App.tsx\n", "Checkout .* is dirty"),
    "not an object": ([HEAD], "", "not a JSON object"),
}


class ArtifactCheckTest(unittest.TestCase):
    def setUp(self):
        self.assertNotEqual(os.geteuid(), 0, "Run fixture tests unprivileged")
        self.temp = tempfile.TemporaryDirectory()
        base = pathlib.Path(self.temp.name)
        shims = base / "bin"
        shims.mkdir()
        for name, body in (("sudo", SUDO), ("git", GIT)):
            (shims / name).write_text(f"#!/bin/bash\n{body}")
            (shims / name).chmod(0o755)
        self.binary = base / "prebuilt"
        self.binary.write_text("#!/bin/sh\nexit 97\n")
        self.binary.chmod(0o755)
        self.dist = base / "dist"
        self.dist.mkdir()
        (self.dist / "index.html").write_text("<html></html>\n")
        self.calls = base / "calls"
        self.env = os.environ.copy()
        self.env.update(
            PATH=f"{shims}:{self.env.get('PATH', '')}",
            ARTIFACT_TEST_CALLS=str(self.calls),
            FAKE_HEAD=HEAD,
            FAKE_STATUS="",
        )
        self.env.pop("FAKE_BUILD_INFO_FAIL", None)

    def tearDown(self):
        self.temp.cleanup()

    def installers(self, check_only):
        flag = ["--check-only"] if check_only else []
        return {
            "factory-api": ["install-factory-api.sh", str(self.binary), *flag],
            "meter": ["install-meter.sh", *flag, str(self.binary)],
            "kiosk": ["install-kiosk.sh", *flag, str(self.dist)],
        }

    def run_all(self, info, status="", check_only=False):
        self.env["FAKE_BUILD_INFO"] = json.dumps(info)
        self.env["FAKE_STATUS"] = status
        (self.dist / "version.json").write_text(json.dumps({"build": "0" * 64, **info} if isinstance(info, dict) else info))
        results = {}
        for name, (script, *args) in self.installers(check_only).items():
            results[name] = subprocess.run(
                ["bash", str(here / script), *args],
                env=self.env,
                text=True,
                capture_output=True,
                check=False,
            )
        return results

    def test_matching_sha_passes_then_reaches_the_root_check(self):
        for check_only in (False, True):
            for name, result in self.run_all({"git_sha": HEAD, "git_dirty": False}, check_only=check_only).items():
                self.assertIn(f"Artifact {name} built at {HEAD} matches checkout", result.stdout)
                self.assertIn("Run as root", result.stderr)
                self.assertEqual(result.returncode, 1)
        # Agent-built binaries and git run as agent, never as the caller.
        calls = self.calls.read_text().splitlines()
        self.assertIn(f"sudo -u agent {self.binary} --build-info", calls)
        self.assertTrue(all(call.startswith("sudo -u agent ") for call in calls))

    def test_refusals_happen_before_any_change(self):
        for check_only in (False, True):
            for case, (info, status, message) in REFUSALS.items():
                for name, result in self.run_all(info, status, check_only).items():
                    with self.subTest(case=case, installer=name, check_only=check_only):
                        self.assertEqual(result.returncode, 1)
                        self.assertRegex(result.stderr, message)
                        self.assertNotIn("matches checkout", result.stdout)
                        self.assertNotIn("Run as root", result.stderr)

    def test_binary_without_build_info_is_refused(self):
        self.env["FAKE_BUILD_INFO_FAIL"] = "1"
        for name, result in self.run_all({"git_sha": HEAD, "git_dirty": False}).items():
            if name == "kiosk":
                continue
            self.assertEqual(result.returncode, 1)
            self.assertIn(f"{name} --build-info failed; rebuild", result.stderr)

    def test_kiosk_dist_without_version_json_is_refused(self):
        self.run_all({"git_sha": HEAD, "git_dirty": False})
        (self.dist / "version.json").unlink()
        result = subprocess.run(
            ["bash", str(here / "install-kiosk.sh"), "--check-only", str(self.dist)],
            env=self.env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("version.json missing", result.stderr)


repo = here.parent
ARTIFACTS = {
    "factory-api": repo / "target/release/factory-api",
    "meter": repo / "target/release/meter",
    "kiosk": repo / "kiosk/dist",
    "factory-devices-agent": repo / "target/release/factory-devices-agent",
}
FAKE_ROOT_SHIMS = {
    "sudo": 'echo "sudo $*" >> "$CALLS"; [[ $1 == -u ]] && shift 2; exec "$@"',
    "systemctl": """echo "systemctl $*" >> "$CALLS"
case "$*" in
  "show --property=Version --value") echo 255 ;;
  *--property=DropInPaths*) echo ;;
  *--property=LoadState*) echo loaded ;;
  "is-enabled "*) echo disabled ;;
  "is-active --quiet "*) exit 0 ;;
  "is-active "*) echo inactive; exit 3 ;;
  *) echo "unexpected systemctl $*" >&2; exit 99 ;;
esac""",
    "curl": 'echo "curl $*" >> "$CALLS"; echo \'{"status":"ok"}\'',
    "tailscale": 'echo "{}"',
    "nvidia-smi": 'echo "GPU 0: fake"',
    "id": 'if [[ $1 == -u ]]; then echo 999; else echo "uid=999($1) gid=999($1)"; fi',
    "getent": 'echo "$2:x:999:"',
}
# Disposable deployment state: tmpfs mounts plus the files each preflight requires.
SETUP = """mkdir -p /run/systemd/system /srv/factory /var/lib/factory-api /var/backups/factory-db /usr/local/bin \\
    /usr/local/lib/factory-backup /etc/systemd/system/ollama.service.d
touch /etc/systemd/system/ollama.service.d/override.conf /etc/factory-backup/nodes.conf \\
    /usr/local/lib/factory-backup/factory-backup.sh /usr/local/lib/factory-backup/restore-check.sh
state() { find /var /run /srv /usr/local /etc/systemd/system /etc/factory-backup -printf '%p %y %m %s\\n' | sort; }
state > "$WORK/before"
"$@"
rc=$?
state > "$WORK/after"
exit $rc
"""


def bwrap_user_namespace():
    try:
        probe = subprocess.run(
            ["bwrap", "--unshare-user", "--uid", "0", "--ro-bind", "/", "/", "true"],
            capture_output=True,
            check=False,
        )
    except FileNotFoundError:
        return False
    return probe.returncode == 0


class FakeRootCheckOnlyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        missing = [str(path) for path in ARTIFACTS.values() if not path.exists()]
        if missing:
            raise unittest.SkipTest(f"build artifacts at HEAD first; missing: {missing}")
        if not bwrap_user_namespace():
            raise unittest.SkipTest("needs Bubblewrap unprivileged user namespaces")
        head = subprocess.check_output(["git", "-C", repo, "rev-parse", "--short=7", "HEAD"], text=True)
        cls.head = head.strip()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.work = pathlib.Path(self.temp.name)
        shims = self.work / "bin"
        shims.mkdir()
        for name, body in FAKE_ROOT_SHIMS.items():
            (shims / name).write_text(f"#!/bin/bash\n{body}\n")
            (shims / name).chmod(0o755)
        (self.work / "tmp").mkdir()
        (self.work / "setup.sh").write_text(SETUP)

    def tearDown(self):
        self.temp.cleanup()

    def check_only(self, checkout, name):
        script = {
            "factory-api": ["deploy/install-factory-api.sh", str(ARTIFACTS["factory-api"]), "--check-only"],
            "meter": ["deploy/install-meter.sh", "--check-only", str(ARTIFACTS["meter"])],
            "kiosk": ["deploy/install-kiosk.sh", "--check-only", str(ARTIFACTS["kiosk"])],
            "factory-devices-agent": ["deploy/devices-agent/install-devices-agent.sh",
                                      str(ARTIFACTS["factory-devices-agent"]), "--check-only"],
        }[name]
        mounts = ["/var", "/run", "/srv", "/usr/local", "/etc/systemd/system", "/etc/factory-backup"]
        node = "factory-console" if name == "factory-devices-agent" else "factory-gpu"
        command = ["bwrap", "--unshare-user", "--uid", "0", "--gid", "0", "--unshare-net", "--unshare-pid",
                   "--unshare-uts", "--hostname", node,
                   "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"]
        for mount in mounts:
            command += ["--tmpfs", mount]
        command += ["--bind", str(self.work), str(self.work)]
        if name == "factory-devices-agent":
            # As root this installer resets PATH, so shadow only what it must not reach.
            for shim in ("sudo", "systemctl"):
                command += ["--ro-bind", str(self.work / "bin" / shim), os.path.realpath(f"/usr/bin/{shim}")]
        command += ["bash", str(self.work / "setup.sh"), "bash", str(checkout / script[0]), *script[1:]]
        env = {
            "PATH": f"{self.work / 'bin'}:/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME": str(self.work),
            "TMPDIR": str(self.work / "tmp"),
            "CALLS": str(self.work / "calls"),
            "WORK": str(self.work),
        }
        result = subprocess.run(command, env=env, text=True, capture_output=True, check=False)
        self.assertEqual((self.work / "before").read_text(), (self.work / "after").read_text(),
                         f"{name} --check-only changed deployment state")
        return result

    def test_build_info_is_one_json_line_with_exactly_the_health_build_fields(self):
        for name in ("factory-api", "meter", "factory-devices-agent"):
            result = subprocess.run([ARTIFACTS[name], "--build-info"], capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, name)
            self.assertEqual(len(result.stdout.splitlines()), 1, name)
            info = json.loads(result.stdout)
            self.assertEqual(sorted(info), ["built_at_ms", "git_dirty", "git_sha", "inputs_fingerprint", "version"])
            self.assertEqual((info["git_sha"], info["git_dirty"]), (self.head, False), name)
        version = json.loads((ARTIFACTS["kiosk"] / "version.json").read_text())
        self.assertEqual((version["git_sha"], version["git_dirty"]), (self.head, False))
        self.assertRegex(version["build"], "^[0-9a-f]{64}$")

    def test_matching_artifact_check_only_exits_zero_and_changes_nothing(self):
        for name in ARTIFACTS:
            with self.subTest(installer=name):
                result = self.check_only(repo, name)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn(f"Artifact {name} built at {self.head} matches checkout", result.stdout)
                self.assertNotRegex(result.stdout + result.stderr, "ERROR")
        calls = (self.work / "calls").read_text()
        self.assertNotRegex(calls, "systemctl (start|stop|restart|enable|disable|daemon-reload)")

    def test_mismatched_checkout_is_refused_naming_both_shas(self):
        # A clean clone one commit ahead: same installers, different HEAD.
        clone = self.work / "checkout"
        subprocess.run(["git", "clone", "-q", "--shared", repo, clone], check=True)
        subprocess.run(["git", "-C", clone, "-c", "user.name=probe", "-c", "user.email=probe@invalid",
                        "commit", "-q", "--allow-empty", "-m", "MET-239 probe"], check=True)
        other = subprocess.check_output(["git", "-C", clone, "rev-parse", "--short=7", "HEAD"], text=True).strip()
        for name in ARTIFACTS:
            with self.subTest(installer=name):
                result = self.check_only(clone, name)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"Artifact {name} built at {self.head} but checkout {clone} is at {other}",
                              result.stderr)
                self.assertNotIn("matches checkout", result.stdout)


if __name__ == "__main__":
    unittest.main()
