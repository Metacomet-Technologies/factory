#!/usr/bin/env python3
"""MET-239: installers refuse artifacts not built from their clean checkout.

Unprivileged, with PATH shims for sudo and git: no real users, services or
installs. The check runs before the root check, so a refusal that never
reaches "Run as root" also changed nothing.
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


if __name__ == "__main__":
    unittest.main()
