#!/usr/bin/env python3
"""MET-239: installers refuse artifacts not built from their clean checkout.

ArtifactCheckTest: unprivileged, with PATH shims for sudo and git. The check
runs before the root check, so a refusal that never reaches "Run as root" also
changed nothing.

FakeRootCheckOnlyTest: the real --check-only path of each installer with real
artifacts built at HEAD (target/release, kiosk/dist), as uid 0 inside an
unprivileged Bubblewrap user namespace. Deployment paths are disposable tmpfs
mounts and system services are shims, so no host state can change.

MeterPlanTest: MET-364, unprivileged. The meter installer relocated into a
temporary tree with command stubs and temporary DBs; --plan and --no-db-change
must classify read-only and refuse DB-generation changes before any change.
"""

import hashlib
import json
import os
import pathlib
import re
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

    def run_all(self, info, status="", check_only=False, source_checkout=None):
        self.env["FAKE_BUILD_INFO"] = json.dumps(info)
        self.env["FAKE_STATUS"] = status
        (self.dist / "version.json").write_text(json.dumps({"build": "0" * 64, **info} if isinstance(info, dict) else info))
        results = {}
        for name, (script, *args) in self.installers(check_only).items():
            if source_checkout is not None:
                args = ["--source-checkout", str(source_checkout), *args]
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

    def test_full_sha_against_historical_source_with_obsolete_installer(self):
        # Real Git identities and clean-tree checks, only sudo/build-info shimmed.
        base = pathlib.Path(self.temp.name)
        (base / "bin/git").unlink()
        source = base / "historical"
        source.mkdir()

        def git(*args):
            return subprocess.check_output(["git", "-C", source, *args], text=True).strip()

        git("init", "-q")
        git("config", "user.name", "Fixture")
        git("config", "user.email", "fixture@example.invalid")
        (source / "deploy").mkdir()
        # The historical tree has no deployer and an installer using the old equality rule.
        (source / "deploy/install-meter.sh").write_text(
            '#!/bin/bash\n[[ $1 == "$(git -C "$2" rev-parse --short=7 HEAD)" ]]\n')
        git("add", ".")
        git("commit", "-qm", "historical release")
        full = git("rev-parse", "HEAD")
        old = subprocess.run(["bash", source / "deploy/install-meter.sh", full, source], check=False)
        self.assertEqual(old.returncode, 1, "historical exact short-SHA equality rejects a full SHA")

        for check_only in (False, True):
            for identity in (full, full[:7]):
                for name, result in self.run_all({"git_sha": identity, "git_dirty": False},
                                                 check_only=check_only, source_checkout=source).items():
                    with self.subTest(installer=name, sha=identity, check_only=check_only):
                        self.assertIn(f"built at {identity} matches checkout", result.stdout)
                        self.assertIn("Run as root", result.stderr)
            # A full SHA sharing the short prefix must still fail, as must dirty artifacts.
            mismatch = full[:7] + ("0" if full[7] != "0" else "1") + full[8:]
            for info, message in (({"git_sha": mismatch, "git_dirty": False}, "built at .* but checkout"),
                                  ({"git_sha": full, "git_dirty": True}, "dirty tree")):
                for result in self.run_all(info, check_only=check_only, source_checkout=source).values():
                    self.assertRegex(result.stderr, message)
                    self.assertNotIn("Run as root", result.stderr)
            (source / "untracked").write_text("preserve this operator change")
            for result in self.run_all({"git_sha": full, "git_dirty": False},
                                       check_only=check_only, source_checkout=source).values():
                self.assertRegex(result.stderr, "Checkout .* is dirty")
                self.assertNotIn("Run as root", result.stderr)
            (source / "untracked").unlink()
        self.assertEqual(git("status", "--porcelain"), "")

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


METER_PLAN_SHIMS = {
    "sudo": """echo "sudo $*" >> "$CALLS"
if [[ $1 == -u && $2 == agent && ${*: -1} == --build-info ]]; then printf '%s\\n' "$FAKE_BUILD_INFO"; exit 0; fi
[[ $1 == -u ]] && shift 2
exec "$@\"""",
    "git": GIT,
    "systemctl": """echo "systemctl $*" >> "$CALLS"
case "$*" in
  *--property=DropInPaths*) echo ;;
  *--property=LoadState*) echo loaded ;;
  "is-enabled "*) echo enabled ;;
  "is-active --quiet "*) exit 0 ;;
  "is-active "*) echo active ;;
  *) exit 0 ;;
esac""",
    "flock": 'echo "flock $*" >> "$CALLS"; exit 1',
    "hostname": "echo factory-gpu",
    "tailscale": 'echo "{}"',
    "nvidia-smi": 'echo "GPU 0: fake"',
    "id": 'if [[ $1 == -u ]]; then echo 999; else echo "uid=999($1) gid=999($1)"; fi',
    "getent": 'echo "$2:x:999:"',
    "ss": "true",
    **{name: f'echo "{name} $*" >> "$CALLS"; exec /usr/bin/{name} "$@"' for name in ("mktemp", "install")},
    "useradd": 'echo "useradd $*" >> "$CALLS"; exit 99',
}
# Relocate the installer's fixed host paths into the fixture tree, as deploy.test.ts does.
HOST_PATHS = re.compile(r"/srv/factory|/usr/local/|/etc/|/var/backups|/run/systemd/system")
DB_STATES = {
    "fresh": ("meter-plan mode=fresh user_version=none db_changing=yes", None),
    "legacy": ("meter-plan mode=legacy user_version=0 db_changing=yes", 0),
    "v1": ("meter-plan mode=v1 user_version=1 db_changing=yes", 1),
    "future": ("meter-plan mode=unknown user_version=3 db_changing=yes", 3),
    "unreadable": ("meter-plan mode=unknown user_version=none db_changing=yes", "garbage"),
    "orphan sidecar": ("meter-plan mode=unknown user_version=none db_changing=yes", "orphan"),
    "symlink": ("meter-plan mode=unknown user_version=none db_changing=yes", "symlink"),
}
V2_PLAN = "meter-plan mode=v2 user_version=2 db_changing=no"
MUTATIONS = re.compile(r"^(mktemp|install|useradd|flock|systemctl (?!show|is-)|meter migrate(?!.*--check-only))", re.M)


class MeterPlanTest(unittest.TestCase):
    """MET-364: --plan and --no-db-change classify the DB generation read-only, unprivileged,
    against temporary DBs and command stubs, and refuse every DB-changing or unknown state
    before staging, service changes, backup locks, snapshots or DB writes."""

    def setUp(self):
        self.assertNotEqual(os.geteuid(), 0, "Run fixture tests unprivileged")
        self.temp = tempfile.TemporaryDirectory()
        base = pathlib.Path(self.temp.name)
        self.tree = base / "host"
        self.calls = base / "calls"
        shims = base / "bin"
        shims.mkdir()
        for name, body in METER_PLAN_SHIMS.items():
            (shims / name).write_text(f"#!/bin/bash\n{body}\n")
            (shims / name).chmod(0o755)
        self.checkout = self.tree / "repo"
        (self.checkout / "deploy").mkdir(parents=True)
        installer = HOST_PATHS.sub(lambda m: f"{self.tree}{m.group(0)}", (here / "install-meter.sh").read_text())
        self.installer = self.checkout / "deploy/install-meter.sh"
        self.installer.write_text(installer.replace("[[ $EUID -eq 0 ]]", "true"))
        (self.checkout / "deploy/meter.service").write_text("[Service]\n")
        (self.checkout / "deploy/set_ollama_host.py").write_text("")
        for directory in ("srv/factory/meter", "usr/local/bin", "usr/local/lib/factory-backup", "run/systemd/system",
                          "var/backups/factory-db", "etc/systemd/system/ollama.service.d", "etc/factory-backup"):
            (self.tree / directory).mkdir(parents=True, exist_ok=True)
        for path in ("etc/systemd/system/ollama.service.d/override.conf", "etc/factory-backup/nodes.conf",
                     "usr/local/lib/factory-backup/factory-backup.sh", "usr/local/lib/factory-backup/restore-check.sh"):
            (self.tree / path).write_text("")
        self.db = self.tree / "srv/factory/meter/meter.db"
        self.binary = base / "prebuilt"
        self.binary.write_text('#!/bin/bash\necho "meter $*" >> "$CALLS"\n')
        self.binary.chmod(0o755)
        self.env = {
            **os.environ, "PATH": f"{shims}:/usr/sbin:/usr/bin:/sbin:/bin", "CALLS": str(self.calls),
            "FAKE_HEAD": HEAD, "FAKE_STATUS": "", "FAKE_BUILD_INFO": json.dumps({"git_sha": HEAD, "git_dirty": False}),
        }

    def tearDown(self):
        self.temp.cleanup()

    def make_db(self, state):
        for path in self.db.parent.glob("meter.db*"):
            path.unlink()
        if state is None:
            return
        if isinstance(state, int):
            subprocess.run(["sqlite3", self.db, f"CREATE TABLE requests(id INTEGER); PRAGMA user_version={state};"], check=True)
        elif state == "garbage":
            self.db.write_bytes(b"not a sqlite database, " * 64)
        elif state == "orphan":
            pathlib.Path(f"{self.db}-wal").write_bytes(b"wal")
        else:
            target = self.db.parent / "elsewhere.db"
            subprocess.run(["sqlite3", target, "PRAGMA user_version=2; CREATE TABLE t(x);"], check=True)
            self.db.symlink_to(target)

    def state(self):
        """Every path, type, mode, mtime and content digest: a staged-and-removed directory still moves its parent's mtime."""
        rows = []
        for path in sorted(self.tree.rglob("*")):
            info = path.lstat()
            digest = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() and not path.is_symlink() else ""
            rows.append((str(path), info.st_mode, info.st_mtime_ns, info.st_size, digest))
        return rows

    def run_installer(self, flag):
        self.calls.write_text("")
        result = subprocess.run(["bash", self.installer, "--source-checkout", self.checkout, flag, self.binary],
                                env=self.env, text=True, capture_output=True, check=False)
        return result, self.calls.read_text()

    def assert_unchanged(self, flag, expected_rc):
        before = self.state()
        result, calls = self.run_installer(flag)
        self.assertEqual(result.returncode, expected_rc, result.stdout + result.stderr)
        self.assertEqual(self.state(), before, f"{flag} changed host state")
        self.assertIsNone(MUTATIONS.search(calls), calls)
        self.assertNotIn(".meter-stage", calls)
        return result

    def test_plan_reports_each_generation_read_only_and_fails_closed(self):
        for case, (line, state) in {**DB_STATES, "v2": (V2_PLAN, 2)}.items():
            with self.subTest(case=case):
                self.make_db(state)
                result = self.assert_unchanged("--plan", 0)
                self.assertEqual(result.stdout.splitlines()[-1], line)
                self.assertEqual(len(re.findall("^meter-plan ", result.stdout, re.M)), 1)

    def test_no_db_change_refuses_db_changing_and_unknown_states_before_any_change(self):
        for case, (line, state) in DB_STATES.items():
            with self.subTest(case=case):
                self.make_db(state)
                result = self.assert_unchanged("--no-db-change", 1)
                self.assertIn("No deployment changes made; no rollback snapshot exists.", result.stderr)
                if case == "symlink":
                    # The existing path-safety preflight refuses it first; --plan above still reports unknown.
                    self.assertIn("Unsafe file", result.stderr)
                    continue
                self.assertIn(line, result.stdout.splitlines())
                self.assertIn("Refusing automatic meter install", result.stderr)

    def test_v2_stays_eligible_and_a_generation_change_after_plan_is_refused(self):
        self.make_db(2)
        self.assertEqual(self.assert_unchanged("--plan", 0).stdout.splitlines()[-1], V2_PLAN)
        db = self.db.read_bytes()
        # Control: v2 passes the recheck, stages and read-only checks, then stops at the busy
        # backup lock (shim) before any snapshot, service change or DB write.
        result, calls = self.run_installer("--no-db-change")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertNotIn("meter-plan", result.stdout)
        self.assertIn("Backup or deployment is running", result.stderr)
        self.assertRegex(calls, r"mktemp -d .*/usr/local/bin/\.meter-stage\.")
        self.assertRegex(calls, r"meter migrate --check-only --db .*/meter\.db")
        self.assertNotRegex(calls, "systemctl (?!show|is-)")
        self.assertEqual(self.db.read_bytes(), db)
        self.assertFalse((self.tree / "var/backups/meter").exists())
        # Drift between the Deployer's plan and its install: v1 or a vanished DB is refused unchanged.
        for state, line in ((1, DB_STATES["v1"][0]), (None, DB_STATES["fresh"][0])):
            with self.subTest(drift=state):
                self.make_db(state)
                result = self.assert_unchanged("--no-db-change", 1)
                self.assertIn(line, result.stdout.splitlines())
                self.assertIn("Refusing automatic meter install", result.stderr)


if __name__ == "__main__":
    unittest.main()
