#!/usr/bin/env python3
"""deploy/autodeploy.sh against a throwaway origin with fake gh, curl and sudo.

Each component's fingerprint at a commit is the content of fp/<component> in
that commit; the running fingerprints are files the fake health endpoints serve.
"""

import fcntl
import json
import os
import pathlib
import subprocess
import tempfile
import unittest

here = pathlib.Path(__file__).resolve().parent
COMPONENTS = ("meter", "factory-api", "kiosk")

FAKE_GH = """#!/usr/bin/env bash
# gh api repos/<repo>/commits/<sha>/check-runs?check_name=ci-ok --jq ...
sha=$(sed -E 's|.*/commits/([0-9a-f]+)/.*|\\1|' <<<"$2")
file=$FAKE/ci/$sha
if [[ -f $file ]]; then cat "$file"; else echo pending; fi
"""
FAKE_CURL = """#!/usr/bin/env bash
url=${!#}
case $url in
    */meter/health) c=meter ;; */v1/health) c=factory-api ;; */version.json) c=kiosk ;;
esac
[[ -f $FAKE/running/$c ]] || exit 7
printf '{"inputs_fingerprint":"%s"}' "$(cat "$FAKE/running/$c")"
"""
FAKE_SUDO = """#!/usr/bin/env bash
[[ $1 == -n ]] && shift
shift  # the factory-deploy path
echo "$*" >> "$FAKE/deploys"
if [[ -f $FAKE/fail ]]; then echo "ERROR: $(cat "$FAKE/fail")" >&2; exit 1; fi
for c in "$@"; do cp "$FAKE/main/$c" "$FAKE/running/$c"; done
"""
FINGERPRINT = """#!/usr/bin/env bash
cat "$(dirname "$0")/fp/$1"
"""


class AutodeployTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        t = pathlib.Path(self.temp.name)
        self.fake, self.state = t / "fake", t / "state"
        for d in ("bin", "ci", "running", "main"):
            (self.fake / d).mkdir(parents=True)
        self.state.mkdir()
        for name, text in (("gh", FAKE_GH), ("curl", FAKE_CURL), ("sudo", FAKE_SUDO)):
            (self.fake / "bin" / name).write_text(text)
            (self.fake / "bin" / name).chmod(0o755)
        self.origin, self.work = t / "origin.git", t / "work"
        self.checkout = t / "checkout"
        self.git("init", "-q", "--bare", "-b", "main", str(self.origin))
        self.git("clone", "-q", str(self.origin), str(self.work))
        (self.work / "fingerprint.sh").write_text(FINGERPRINT)
        (self.work / "fingerprint.sh").chmod(0o755)
        (self.work / "fp").mkdir()
        self.env = {**os.environ, "PATH": f"{self.fake / 'bin'}:{os.environ['PATH']}",
                    "FAKE": str(self.fake), "STATE_DIRECTORY": str(self.state),
                    "FACTORY_CHECKOUT": str(self.checkout),
                    "FACTORY_DEPLOY_LOCK": str(t / "deploy.lock"),
                    "FACTORY_FINGERPRINT": "fingerprint.sh",
                    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                    "GIT_COMMITTER_EMAIL": "t@t"}
        self.first = self.push(meter="m1", **{"factory-api": "a1"}, kiosk="k1")
        self.git("clone", "-q", str(self.origin), str(self.checkout))
        for c, fp in zip(COMPONENTS, ("m1", "a1", "k1")):
            (self.fake / "running" / c).write_text(fp)

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args, cwd=None):
        return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True,
                              env=getattr(self, "env", None)).stdout.strip()

    def push(self, ci=None, **fingerprints):
        for c, fp in fingerprints.items():
            (self.work / "fp" / c).write_text(fp)
        self.git("add", "-A", cwd=self.work)
        self.git("commit", "-q", "--allow-empty", "-m", "change", cwd=self.work)
        self.git("push", "-q", "origin", "main", cwd=self.work)
        sha = self.git("rev-parse", "HEAD", cwd=self.work)
        for c in COMPONENTS:
            (self.fake / "main" / c).write_text((self.work / "fp" / c).read_text())
        if ci:
            (self.fake / "ci" / sha).write_text(ci)
        return sha

    def run_deployer(self):
        result = subprocess.run(["bash", str(here / "autodeploy.sh")], env=self.env,
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads((self.state / "status.json").read_text())

    def deploys(self):
        path = self.fake / "deploys"
        return path.read_text().splitlines() if path.exists() else []

    def test_waits_for_green_ci_and_never_deploys_red(self):
        sha = self.push(**{"factory-api": "a2"})
        status = self.run_deployer()
        self.assertEqual((status["main_sha"], status["ci"]), (sha, "pending"))
        sha = self.push(ci="failure", **{"factory-api": "a3"})
        status = self.run_deployer()
        self.assertEqual((status["main_sha"], status["ci"]), (sha, "failure"))
        self.assertEqual(self.deploys(), [])

    def test_deploys_only_components_whose_inputs_changed(self):
        self.push(ci="success", kiosk="k2", meter="m2")
        status = self.run_deployer()
        self.assertEqual(self.deploys(), ["meter kiosk"])
        self.assertEqual((status["ci"], status["deploy_failure"]), ("success", None))
        self.run_deployer()
        self.assertEqual(self.deploys(), ["meter kiosk"], "a current production deploys nothing")

    def test_failed_sha_is_not_retried_and_next_green_push_clears_it(self):
        (self.fake / "fail").write_text("factory-api rolled back; later components were not deployed.")
        bad = self.push(ci="success", **{"factory-api": "a2"})
        status = self.run_deployer()
        self.assertEqual(status["deploy_failure"], {
            "sha": bad, "components": ["factory-api"],
            "detail": "factory-api rolled back; later components were not deployed."})
        self.run_deployer()
        self.assertEqual(self.deploys(), ["factory-api"], "the failed SHA is not retried")
        (self.fake / "fail").unlink()
        self.push(ci="success", **{"factory-api": "a3"})
        status = self.run_deployer()
        self.assertEqual(self.deploys(), ["factory-api", "factory-api"])
        self.assertIsNone(status["deploy_failure"])

    def test_waits_while_a_manual_deploy_holds_the_lock(self):
        self.push(ci="success", kiosk="k2")
        lock = self.env["FACTORY_DEPLOY_LOCK"]
        with open(lock, "w") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            status = self.run_deployer()
        self.assertEqual(self.deploys(), [])
        self.assertIsNone(status["deploy_failure"])
        self.run_deployer()
        self.assertEqual(self.deploys(), ["kiosk"])

    def test_unknown_running_build_is_deployed(self):
        (self.fake / "running" / "meter").unlink()
        self.push(ci="success")
        self.run_deployer()
        self.assertEqual(self.deploys(), ["meter"])


if __name__ == "__main__":
    unittest.main()
