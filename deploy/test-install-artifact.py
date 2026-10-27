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

TrustedTreeTest: MET-375, unprivileged. A staged tree relocated into a temporary directory, with a stat
shim that reports the test user as root; the allowlisted scripts refuse a missing, changed, symlinked
or writable asset before any sudo call, and rollbacks accept only an installer snapshot.
"""

import fcntl
import hashlib
import json
import os
import pathlib
import re
import shutil
import sqlite3
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
if [[ ${WRITER_ON:-} == systemctl && $1 == stop ]]; then python3 "$WRITER" "$WRITER_DB"; fi
case "$*" in
  *--property=DropInPaths*) echo ;;
  *--property=LoadState*) echo loaded ;;
  "is-enabled "*) echo enabled ;;
  "is-active --quiet "*) exit 0 ;;
  "is-active "*) echo active ;;
  *) exit 0 ;;
esac""",
    # The real flock(1): the installer really holds the fixture's backup lock (hold_backup_lock makes it busy).
    "flock": 'echo "flock $*" >> "$CALLS"; exec /usr/bin/flock "$@"',
    "hostname": "echo factory-gpu",
    "tailscale": 'echo "{}"',
    "nvidia-smi": 'echo "GPU 0: fake"',
    "id": 'if [[ $1 == -u ]]; then echo 999; else echo "uid=999($1) gid=999($1)"; fi',
    "getent": 'echo "$2:x:999:"',
    "ss": "true",
    "install": 'echo "install $*" >> "$CALLS"; exec /usr/bin/install "$@"',
    "mktemp": """echo "mktemp $*" >> "$CALLS"
if [[ ${WRITER_ON:-} == mktemp && $* == *"$WRITER_MATCH"* ]]; then python3 "$WRITER" "$WRITER_DB"; fi
exec /usr/bin/mktemp "$@\"""",
    "useradd": 'echo "useradd $*" >> "$CALLS"; exit 99',
    # A concurrent writer: WRITER runs right after the classifier copies the main file into scratch
    # (WRITER_ON=cp), right after a successful comparison of the live WAL (WRITER_ON=cmp), right before
    # a mktemp whose arguments contain WRITER_MATCH (staging, snapshot), or right before `systemctl stop`.
    "cp": '/usr/bin/cp "$@" || exit; if [[ ${WRITER_ON:-} == cp && ${*: -1} == */meter.db ]]; then python3 "$WRITER" "${@: -2:1}"; fi',
    "cmp": '/usr/bin/cmp "$@" || exit; if [[ ${WRITER_ON:-} == cmp && ${*: -2:1} == */meter.db-wal ]]; then python3 "$WRITER" "${@: -2:1}"; fi',
}
# `once`: one real TRUNCATE checkpoint (no version change); `churn`: a commit and a checkpoint on every
# copy; `downgrade`: one commit setting user_version=1, left in the WAL; `downgrade checkpoint`: the same
# commit, then checkpointed into the main-file header. Non-churn writers act on hook call WRITER_AFTER (0-based).
# With WRITER_LOCK set the writer follows the generation-writer protocol of install-meter.sh and
# rollback-meter-v1.sh: it writes only after taking the backup lock nonblocking, else records `b`.
WRITER = """import fcntl, os, pathlib, sqlite3, sys
marker = pathlib.Path(os.environ["WRITER_MARK"])
mode = os.environ["WRITER_MODE"]
seen = marker.read_text() if marker.exists() else ""
if mode != "churn" and len(seen) != int(os.environ.get("WRITER_AFTER", "0")):
    if len(seen) < int(os.environ.get("WRITER_AFTER", "0")):
        marker.write_text(seen + ".")
    sys.exit()
if os.environ.get("WRITER_LOCK"):
    lock = open(os.environ["WRITER_LOCK"], "a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        marker.write_text(seen + "b")
        sys.exit()
marker.write_text(seen + "x")
con = sqlite3.connect(sys.argv[1].removesuffix("-wal"), isolation_level=None)
if mode.startswith("downgrade"):
    con.execute("PRAGMA user_version=1")
    if mode == "downgrade checkpoint":
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
else:
    if mode == "churn":
        con.execute("INSERT INTO requests VALUES (1)")
    con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
con.close()
"""
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
    "symlinked parent": ("meter-plan mode=unknown user_version=none db_changing=yes", "parent symlink"),
    "symlinked shm": ("meter-plan mode=unknown user_version=none db_changing=yes", "shm symlink"),
    "hot journal": ("meter-plan mode=unknown user_version=none db_changing=yes", "journal"),
    # The application runs WAL: a stopped WAL DB has no sidecars, and a committed version can still be in the WAL.
    "stopped WAL v1": ("meter-plan mode=v1 user_version=1 db_changing=yes", ("wal", 1)),
    "v1 committed in WAL over a v2 file": ("meter-plan mode=v1 user_version=1 db_changing=yes", ("pending", 2, 1)),
}
V2_PLAN = "meter-plan mode=v2 user_version=2 db_changing=no"
V2_STATES = {"v2": 2, "stopped WAL v2": ("wal", 2), "v2 committed in WAL over a v1 file": ("pending", 1, 2)}
# Scratch mktemp (no template, under TMPDIR) is allowed; any templated host path is a mutation.
MUTATIONS = re.compile(r"^(mktemp .*/|install|useradd|flock|systemctl (?!show|is-)|meter migrate(?!.*--check-only))", re.M)


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
                     "usr/local/lib/factory-backup/factory-backup.sh", "usr/local/lib/factory-backup/restore-check.sh",
                     "var/backups/factory-db/.backup.lock"):
            (self.tree / path).write_text("")
        self.db = self.tree / "srv/factory/meter/meter.db"
        self.lock = self.tree / "var/backups/factory-db/.backup.lock"
        self.binary = base / "prebuilt"
        self.binary.write_text('#!/bin/bash\necho "meter $*" >> "$CALLS"\n')
        self.binary.chmod(0o755)
        self.env = {
            **os.environ, "PATH": f"{shims}:/usr/sbin:/usr/bin:/sbin:/bin", "CALLS": str(self.calls),
            "FAKE_HEAD": HEAD, "FAKE_STATUS": "", "FAKE_BUILD_INFO": json.dumps({"git_sha": HEAD, "git_dirty": False}),
            "TMPDIR": str(base / "tmp"),
        }
        (base / "tmp").mkdir()
        self.scratch = base / "tmp"

    def tearDown(self):
        self.temp.cleanup()

    def hold_backup_lock(self):
        """A running backup or deployment: the real lock, held from another open file description."""
        handle = open(self.lock, "a")
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle

    def make_db(self, state):
        if self.db.parent.is_symlink():
            self.db.parent.unlink()
            shutil.rmtree(self.db.parent.parent / "meter-real")
            self.db.parent.mkdir()
        for path in self.db.parent.iterdir():
            path.unlink()
        if state is None:
            return
        if isinstance(state, int):
            subprocess.run(["sqlite3", self.db, f"CREATE TABLE requests(id INTEGER); PRAGMA user_version={state};"], check=True)
        elif state == "garbage":
            self.db.write_bytes(b"not a sqlite database, " * 64)
        elif state == "orphan":
            pathlib.Path(f"{self.db}-wal").write_bytes(b"wal")
        elif state == "parent symlink":
            real = self.db.parent.parent / "meter-real"
            self.db.parent.rmdir()
            real.mkdir()
            self.db.parent.symlink_to(real)
            subprocess.run(["sqlite3", real / "meter.db", "PRAGMA user_version=2; CREATE TABLE t(x);"], check=True)
        elif state == "shm symlink":
            self.make_db(2)
            pathlib.Path(f"{self.db}-shm").symlink_to(self.db.parent.parent / "elsewhere-shm")
        elif state == "journal":
            self.make_db(2)
            pathlib.Path(f"{self.db}-journal").write_bytes(b"\xd9\xd5\x05\xf9\x20\xa1\x63\xd7" + b"\0" * 504)
        elif state[0] == "wal":
            con = sqlite3.connect(self.db, isolation_level=None)
            con.execute("PRAGMA journal_mode=WAL")
            con.execute("CREATE TABLE requests(id INTEGER)")
            con.execute(f"PRAGMA user_version={state[1]}")
            con.close()
            self.assertEqual(sorted(path.name for path in self.db.parent.iterdir()), ["meter.db"])
        elif state[0] == "pending":
            # Committed to the WAL but not checkpointed: the main file still says the other version.
            build = self.db.parent.parent / "build.db"
            con = sqlite3.connect(build, isolation_level=None)
            con.execute("PRAGMA journal_mode=WAL")
            con.execute("CREATE TABLE requests(id INTEGER)")
            con.execute(f"PRAGMA user_version={state[1]}")
            con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            con.execute("PRAGMA wal_autocheckpoint=0")
            con.execute(f"PRAGMA user_version={state[2]}")
            shutil.copyfile(build, self.db)
            shutil.copyfile(f"{build}-wal", f"{self.db}-wal")
            con.close()
            build.unlink()
            self.assertEqual(int.from_bytes(self.db.read_bytes()[60:64], "big"), state[1])
            self.assertGreater(pathlib.Path(f"{self.db}-wal").stat().st_size, 0)
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
        self.assertEqual(list(self.scratch.iterdir()), [], "scratch copy not removed")
        return result

    def test_plan_reports_each_generation_read_only_and_fails_closed(self):
        for case, (line, state) in {**DB_STATES, **{name: (V2_PLAN, state) for name, state in V2_STATES.items()}}.items():
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
                self.assertIn(line, result.stdout.splitlines())
                self.assertIn("Refusing automatic meter install", result.stderr)

    def test_v2_stays_eligible_and_a_generation_change_after_plan_is_refused(self):
        for case, state in V2_STATES.items():
            with self.subTest(eligible=case):
                self.make_db(state)
                self.assertEqual(self.assert_unchanged("--plan", 0).stdout.splitlines()[-1], V2_PLAN)
                files = {path.name: path.read_bytes() for path in self.db.parent.iterdir()}
                # Control: v2 passes the recheck, then stops at the busy backup lock before
                # staging, any snapshot, service change or DB write.
                with self.hold_backup_lock():
                    result, calls = self.run_installer("--no-db-change")
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertNotIn("meter-plan", result.stdout)
                self.assertIn("Backup or deployment is running", result.stderr)
                self.assertIn("flock -n 9", calls)
                self.assertNotIn(".meter-stage", calls)
                self.assertNotRegex(calls, "meter migrate|systemctl (?!show|is-)")
                self.assertEqual({path.name: path.read_bytes() for path in self.db.parent.iterdir()}, files)
                self.assertFalse((self.tree / "var/backups/meter").exists())
                # Control: with the lock free, v2 passes the locked recheck and stages, and the read-only
                # check runs on the unchanged DB; the fixture then stops at the stopped-PID check.
                result, calls = self.run_installer("--no-db-change")
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertNotIn("meter-plan", result.stdout)
                self.assertIn("Meter PID remains after stop", result.stderr)
                self.assertEqual(calls.count("flock -n 9"), 1)
                self.assertRegex(calls, r"mktemp -d .*/usr/local/bin/\.meter-stage\.")
                self.assertRegex(calls, r"meter migrate --check-only --db .*/meter\.db")
                self.assertEqual({path.name: path.read_bytes() for path in self.db.parent.iterdir()}, files)
                shutil.rmtree(self.tree / "var/backups/meter")
        # Drift between the Deployer's plan and its install: v1 or a vanished DB is refused unchanged.
        for state, line in ((1, DB_STATES["v1"][0]), (None, DB_STATES["fresh"][0]), ("symlink", DB_STATES["symlink"][0])):
            with self.subTest(drift=state):
                self.make_db(state)
                result = self.assert_unchanged("--no-db-change", 1)
                self.assertIn(line, result.stdout.splitlines())
                self.assertIn("Refusing automatic meter install", result.stderr)

    def run_with_writer(self, flag, mode, on="cp", after=0, locked=False):
        hook = self.scratch.parent / "writer.py"
        hook.write_text(WRITER)
        marker = self.scratch.parent / "writer-ran"
        marker.unlink(missing_ok=True)
        self.env.update(WRITER=str(hook), WRITER_MODE=mode, WRITER_MARK=str(marker), WRITER_ON=on,
                        WRITER_AFTER=str(after))
        try:
            result, calls = self.run_installer(flag)
        finally:
            for name in ("WRITER", "WRITER_MODE", "WRITER_MARK", "WRITER_ON", "WRITER_AFTER"):
                self.env.pop(name, None)
        self.assertIn("x", marker.read_text() if marker.exists() else "", "the writer never ran")
        # No staging, migration, service action or snapshot; scratch removed. Taking the lock writes nothing.
        self.assertIsNone(MUTATIONS.search(calls.replace("flock -n 9\n", "") if locked else calls), calls)
        self.assertNotIn(".meter-stage", calls)
        self.assertEqual(list(self.scratch.iterdir()), [])
        self.assertFalse((self.tree / "var/backups/meter").exists())
        return result, marker.read_text()

    def assert_plan(self, flag, result, line):
        self.assertIn(line, result.stdout.splitlines())
        if flag == "--plan":
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("Refusing automatic meter install", result.stderr)

    def test_a_checkpoint_between_the_copies_never_reads_a_stale_v2(self):
        # The main file says 2 while the committed generation (in the WAL) is 1 or 3 throughout;
        # a real checkpoint right after the main-file copy must not pair it with the consumed WAL.
        for flag in ("--plan", "--no-db-change"):
            for committed, line in ((1, DB_STATES["v1"][0]), (3, DB_STATES["future"][0])):
                with self.subTest(flag=flag, committed=committed):
                    self.make_db(("pending", 2, committed))
                    con = sqlite3.connect(self.db, isolation_level=None)
                    self.assertEqual(con.execute("PRAGMA user_version").fetchone()[0], committed)
                    result, _ = self.run_with_writer(flag, "once")
                    self.assertEqual(con.execute("PRAGMA user_version").fetchone()[0], committed)
                    con.close()
                    self.assert_plan(flag, result, line)

    def test_a_db_changing_on_every_capture_fails_closed_after_bounded_retries(self):
        for flag in ("--plan", "--no-db-change"):
            with self.subTest(flag=flag):
                self.make_db(("wal", 2))
                result, runs = self.run_with_writer(flag, "churn")
                self.assertEqual(runs, "xxxxx")
                self.assert_plan(flag, result, "meter-plan mode=unknown user_version=none db_changing=yes")

    def test_a_commit_after_the_comparison_never_reads_a_stale_v2(self):
        # Committed v2 in a non-empty WAL; right after the classifier's first successful WAL comparison a
        # writer commits user_version=1 (WAL grows, main file unchanged). The scratch copy still says 2.
        for flag in ("--plan", "--no-db-change"):
            with self.subTest(flag=flag):
                self.make_db(("pending", 1, 2))
                con = sqlite3.connect(self.db, isolation_level=None)
                self.assertEqual(con.execute("PRAGMA user_version").fetchone()[0], 2)
                result, _ = self.run_with_writer(flag, "downgrade", on="cmp")
                self.assertEqual(con.execute("PRAGMA user_version").fetchone()[0], 1)
                con.close()
                self.assert_plan(flag, result, DB_STATES["v1"][0])

    def test_a_commit_after_the_last_comparison_is_refused_before_staging(self):
        # Committed v2 in a non-empty WAL. The writer commits user_version=1 (left in the WAL, or
        # checkpointed so the main-file header says 1) right after the second WAL comparison, which the
        # post-mode comparison catches; or after the last comparison, which only the classification under
        # the backup lock catches. Generation writers hold that lock, so the locked read is current.
        cases = [(flag, mode, 1, False) for flag in ("--plan", "--no-db-change") for mode in ("downgrade", "downgrade checkpoint")]
        cases += [("--no-db-change", mode, 2, True) for mode in ("downgrade", "downgrade checkpoint")]
        for flag, mode, after, lock in cases:
            with self.subTest(flag=flag, mode=mode, after=after):
                self.make_db(("pending", 1, 2))
                result, _ = self.run_with_writer(flag, mode, on="cmp", after=after, locked=lock)
                con = sqlite3.connect(self.db, isolation_level=None)
                self.assertEqual(con.execute("PRAGMA user_version").fetchone()[0], 1)
                con.close()
                if mode == "downgrade checkpoint":
                    self.assertEqual(int.from_bytes(self.db.read_bytes()[60:64], "big"), 1)
                self.assert_plan(flag, result, DB_STATES["v1"][0])
                if lock:
                    self.assertIn("under the backup lock", result.stderr)


    def test_generation_writers_are_excluded_by_the_backup_lock_from_classification_to_service_stop(self):
        # The exclusion is the lock, not the comparisons: every DB-generation writer (this installer and
        # rollback-meter-v1.sh) takes the backup lock nonblocking, and meter serve never writes
        # user_version. A protocol writer that tries to commit user_version=1 (and checkpoint it) after the
        # locked classification's last WAL comparison, before staging, before the snapshot or before the stop
        # finds the lock busy and writes nothing, so the v2 the install accepted is the live generation
        # through every mutation up to the stop; the fixture then stops at the stopped-PID check.
        boundaries = {"last locked comparison": {"WRITER_ON": "cmp", "WRITER_AFTER": "5"},
                      "staging": {"WRITER_ON": "mktemp", "WRITER_MATCH": ".meter-stage"},
                      "snapshot": {"WRITER_ON": "mktemp", "WRITER_MATCH": "var/backups/meter/"},
                      "service stop": {"WRITER_ON": "systemctl"}}
        hook = self.scratch.parent / "writer.py"
        hook.write_text(WRITER)
        marker = self.scratch.parent / "writer-ran"
        for boundary, hook_env in boundaries.items():
            with self.subTest(boundary=boundary):
                self.make_db(("pending", 1, 2))
                shutil.rmtree(self.tree / "var/backups/meter", ignore_errors=True)
                marker.unlink(missing_ok=True)
                env = {"WRITER": str(hook), "WRITER_MODE": "downgrade checkpoint", "WRITER_MARK": str(marker),
                       "WRITER_DB": str(self.db), "WRITER_LOCK": str(self.lock), **hook_env}
                self.env.update(env)
                try:
                    result, calls = self.run_installer("--no-db-change")
                finally:
                    for name in env:
                        self.env.pop(name)
                self.assertTrue(marker.read_text().endswith("b"), "the writer did not meet the held lock")
                self.assertIn("Meter PID remains after stop", result.stderr)
                self.assertRegex(calls, r"meter migrate --check-only --db .*/meter\.db")
                (snapshot,) = (self.tree / "var/backups/meter").iterdir()
                self.assertEqual((snapshot / "mode").read_text(), "v2\n")
                self.assertFalse((snapshot / "db-changing").exists())
                con = sqlite3.connect(self.db, isolation_level=None)
                self.assertEqual(con.execute("PRAGMA user_version").fetchone()[0], 2)
                con.close()
                # Control: once the installer exits and releases the lock, the same writer commits.
                marker.unlink()
                subprocess.run(["python3", hook, self.db], env={**self.env, **env, "WRITER_AFTER": "0"}, check=True)
                self.assertEqual(marker.read_text(), "x")
                con = sqlite3.connect(self.db, isolation_level=None)
                self.assertEqual(con.execute("PRAGMA user_version").fetchone()[0], 1)
                con.close()


TRUSTED = "/usr/local/lib/factory-deploy"
# The test user stands in for root inside FAKE_ROOT_TREE; every ancestor outside it is root-owned 0755.
STAT = """[[ $1 == -c ]] || exec /usr/bin/stat "$@"
fmt=$2 p=${*: -1}
if [[ $p != "$FAKE_ROOT_TREE" && $p != "$FAKE_ROOT_TREE"/* ]]; then
    case $fmt in '%u %a') echo '0 755' ;; %u) echo 0 ;; %a) echo 755 ;; *) exec /usr/bin/stat "$@" ;; esac
    exit 0
fi
out=$(/usr/bin/stat "$@") || exit
if [[ $fmt == %u* && ${out%% *} == "$(id -u)" ]]; then out="0${out#"$(id -u)"}"; fi
printf '%s\\n' "$out"
"""
# label: (script, args) for each entry point a root caller can reach in the staged tree, and what it
# prints once its trusted-asset check has passed, still before any change.
ENTRY_POINTS = {
    "install-meter.sh": ("install-meter.sh", lambda binary, dist: [str(binary)], "matches checkout"),
    "install-factory-api.sh": ("install-factory-api.sh", lambda binary, dist: [str(binary)], "matches checkout"),
    "install-kiosk.sh": ("install-kiosk.sh", lambda binary, dist: [str(dist)], "matches checkout"),
    "install-kiosk.sh --rollback": ("install-kiosk.sh", lambda binary, dist: ["--rollback", "/var/backups/factory-kiosk/snap"], "Run as root"),
    "rollback-meter.sh": ("rollback-meter.sh", lambda binary, dist: [], "Run as root"),
    "rollback-meter-v1.sh": ("rollback-meter-v1.sh", lambda binary, dist: ["/var/backups/meter/snap"], "Run as root"),
    "rollback-factory-api.sh": ("rollback-factory-api.sh", lambda binary, dist: ["/var/backups/factory-api/snap"], "Run as root"),
}
ASSETS = ["deploy/sudoers/trusted-assets.sh", "deploy/install-meter.sh", "deploy/meter.service", "deploy/set_ollama_host.py",
          "deploy/rollback-meter-v1.sh", "deploy/rollback-meter.sh", "deploy/install-factory-api.sh", "deploy/factory-api.service",
          "deploy/alerts/factory-api-alerts.conf", "deploy/device-tokens.sh", "deploy/rollback-factory-api.sh", "deploy/install-kiosk.sh",
          "deploy/rollback-kiosk.sh"]


class TrustedTreeTest(unittest.TestCase):
    def setUp(self):
        self.assertNotEqual(os.geteuid(), 0, "Run fixture tests unprivileged")
        self.temp = tempfile.TemporaryDirectory()
        self.base = pathlib.Path(self.temp.name)
        self.tree = self.base / "lib/factory-deploy"
        shims = self.base / "bin"
        shims.mkdir()
        for name, body in (("sudo", SUDO), ("git", GIT), ("stat", STAT)):
            (shims / name).write_text(f"#!/bin/bash\n{body}")
            (shims / name).chmod(0o755)
        self.binary = self.base / "prebuilt"
        self.binary.write_text("#!/bin/sh\nexit 97\n")
        self.binary.chmod(0o755)
        self.dist = self.base / "dist"
        self.dist.mkdir()
        (self.dist / "index.html").write_text("<html></html>\n")
        info = {"git_sha": HEAD, "git_dirty": False}
        (self.dist / "version.json").write_text(json.dumps({"build": "0" * 64, **info}))
        self.calls = self.base / "calls"
        self.env = {**os.environ, "PATH": f"{shims}:/usr/sbin:/usr/bin:/sbin:/bin", "ARTIFACT_TEST_CALLS": str(self.calls),
                    "FAKE_HEAD": HEAD, "FAKE_STATUS": "", "FAKE_BUILD_INFO": json.dumps(info), "FAKE_ROOT_TREE": str(self.tree)}
        self.stage()

    def tearDown(self):
        self.temp.cleanup()

    def stage(self):
        """What stage-trusted.sh leaves: the release files, relocated, 0644 in 0755 directories, and SHA256SUMS."""
        shutil.rmtree(self.tree, ignore_errors=True)
        for name in ASSETS:
            path = self.tree / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text((repo / name).read_text().replace(TRUSTED, str(self.tree)))
            path.chmod(0o644)
        for directory in [self.tree, *self.tree.rglob("*")]:
            if directory.is_dir():
                directory.chmod(0o755)
        sums = subprocess.run(["bash", "-c", "find . -type f -printf '%P\\0' | LC_ALL=C sort -z | xargs -0 sha256sum --"],
                              cwd=self.tree, capture_output=True, text=True, check=True).stdout
        (self.tree / "SHA256SUMS").write_text(sums)

    def run_entry(self, script, env=None):
        self.calls.unlink(missing_ok=True)
        name, args, _ = ENTRY_POINTS[script]
        result = subprocess.run(["bash", str(self.tree / "deploy" / name), *args(self.binary, self.dist)], env=env or self.env,
                                text=True, capture_output=True, check=False)
        calls = self.calls.read_text() if self.calls.exists() else ""
        return result, calls

    def assert_refused(self, script, message, env=None):
        result, calls = self.run_entry(script, env)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertRegex(result.stderr, message)
        self.assertNotIn(ENTRY_POINTS[script][2], result.stdout + result.stderr)
        self.assertEqual(calls, "", "a refused tree ran nothing through sudo")

    def test_intact_staged_tree_passes_every_entry_point(self):
        for script in ENTRY_POINTS:
            with self.subTest(script=script):
                result, _ = self.run_entry(script)
                self.assertIn(ENTRY_POINTS[script][2], result.stdout + result.stderr)
                self.assertNotIn("trusted asset", (result.stdout + result.stderr).lower())

    def test_tree_owned_by_a_non_root_user_is_refused(self):
        # Asymmetric control: without the stat shim the test user is not root, so the same tree is refused.
        env = {**self.env, "PATH": self.env["PATH"].replace(str(self.base / "bin"), str(self.base / "nostat"))}
        (self.base / "nostat").mkdir()
        for name in ("sudo", "git"):
            (self.base / "nostat" / name).symlink_to(self.base / "bin" / name)
        for script in ENTRY_POINTS:
            with self.subTest(script=script):
                self.assert_refused(script, f"Trusted asset is writable by a non-root user: {self.tree}", env)

    def test_tampered_missing_symlinked_and_writable_assets_are_refused_before_any_change(self):
        def append(name):
            with open(self.tree / name, "a") as handle:
                handle.write("# tampered\n")

        def symlink_file(name):
            copy = self.base / "agent-copy"
            shutil.copyfile(self.tree / name, copy)
            (self.tree / name).unlink()
            (self.tree / name).symlink_to(copy)

        def symlink_parent(_name):
            shutil.rmtree(self.base / "agent-sudoers", ignore_errors=True)
            shutil.copytree(self.tree / "deploy/sudoers", self.base / "agent-sudoers")
            shutil.rmtree(self.tree / "deploy/sudoers")
            (self.tree / "deploy/sudoers").symlink_to(self.base / "agent-sudoers")

        def drop_digest(name):
            sums = self.tree / "SHA256SUMS"
            sums.write_text("".join(line for line in sums.read_text().splitlines(True) if not line.endswith(f"  {name}\n")))

        def duplicate_digest(name):
            sums = self.tree / "SHA256SUMS"
            sums.write_text(sums.read_text() + next(line for line in sums.read_text().splitlines(True) if line.endswith(f"  {name}\n")))

        cases = {
            "script changed after staging": (append, "Trusted asset changed since staging: .*/deploy/{script}"),
            "script symlinked to an agent copy": (symlink_file, "Refusing symlinked trusted asset: .*/deploy/{script}"),
            "helper directory symlinked": (symlink_parent, "Refusing symlinked trusted asset: .*/deploy/sudoers"),
            "script group-writable": (lambda name: (self.tree / name).chmod(0o664), "writable by a non-root user: .*/deploy/{script}"),
            "parent other-writable": (lambda name: (self.tree / "deploy").chmod(0o757), "writable by a non-root user: .*/deploy$"),
            "digest list missing": (lambda name: (self.tree / "SHA256SUMS").unlink(), "Missing trusted asset: .*/SHA256SUMS"),
            "no digest for the script": (drop_digest, "No staged digest for deploy/{script}"),
            "duplicate digest": (duplicate_digest, "Duplicate staged digest: deploy/{script}"),
        }
        for case, (tamper, message) in cases.items():
            for label, (script, _, _) in ENTRY_POINTS.items():
                with self.subTest(case=case, entry=label):
                    self.stage()
                    tamper(f"deploy/{script}")
                    self.assert_refused(label, re.compile(message.format(script=re.escape(script)), re.M))
        # A helper an installer reads as root, not only the script itself: changed or missing.
        helpers = (("deploy/meter.service", "install-meter.sh"), ("deploy/set_ollama_host.py", "rollback-meter.sh"),
                   ("deploy/factory-api.service", "install-factory-api.sh"), ("deploy/device-tokens.sh", "rollback-factory-api.sh"),
                   ("deploy/rollback-meter-v1.sh", "install-meter.sh"), ("deploy/alerts/factory-api-alerts.conf", "rollback-factory-api.sh"),
                   ("deploy/rollback-kiosk.sh", "install-kiosk.sh --rollback"), ("deploy/rollback-kiosk.sh", "install-kiosk.sh"))
        for name, script in helpers:
            for case, tamper, message in (("changed", append, "Trusted asset changed since staging"), ("missing", lambda n: (self.tree / n).unlink(), "Missing trusted asset")):
                with self.subTest(helper=name, case=case):
                    self.stage()
                    tamper(name)
                    self.assert_refused(script, f"{message}: .*/{re.escape(name)}")

    def test_every_allowlisted_script_is_a_covered_entry_point(self):
        # Each sudoers entry names a staged script that the tamper cases above run; a new entry without a
        # trusted-asset check, or one naming another tree, fails here.
        entries = re.findall(r"^\s*/usr/bin/bash (\S+) \*", (repo / "deploy/sudoers/factory-agent-deploy").read_text(), re.M)
        self.assertEqual(sorted(entries), sorted({f"{TRUSTED}/deploy/{script}" for script, _, _ in ENTRY_POINTS.values()} - {f"{TRUSTED}/deploy/rollback-meter.sh"}))
        for entry in entries:
            self.assertIn("trusted_assets deploy/sudoers/trusted-assets.sh", pathlib.Path(repo, entry.removeprefix(f"{TRUSTED}/")).read_text(), entry)

    def test_meter_reads_its_unit_from_its_own_tree_not_the_callers_checkout(self):
        # The caller's checkout holds no unit; only the build identity is checked against it.
        checkout = self.base / "caller"
        checkout.mkdir()
        result = subprocess.run(["bash", str(self.tree / "deploy/install-meter.sh"), "--source-checkout", str(checkout), str(self.binary)],
                                env=self.env, text=True, capture_output=True, check=False)
        self.assertIn(f"matches checkout", result.stdout)
        installer = (repo / "deploy/install-meter.sh").read_text()
        self.assertNotIn("$checkout/deploy/", installer)
        self.assertNotIn("$checkout/deploy/", (repo / "deploy/install-factory-api.sh").read_text())

    def test_rollbacks_accept_only_a_root_owned_installer_snapshot(self):
        backups = self.base / "backups"
        incomplete = "Snapshot is incomplete"
        cases = (("rollback-meter-v1.sh", [], "/var/backups/meter", incomplete), ("rollback-factory-api.sh", [], "/var/backups/factory-api", incomplete),
                 # The kiosk rollback is reached only through the installer, which then runs rollback-kiosk.sh (stubbed).
                 ("install-kiosk.sh", ["--rollback"], "/var/backups/factory-kiosk", "ROLLBACK-KIOSK"))
        for script, flags, directory, passed in cases:
            with self.subTest(script=script):
                home = backups / directory.rsplit("/", 1)[1]
                home.mkdir(parents=True)
                # Not run from the staged tree: only the snapshot rule is under test, as uid 0.
                body = (repo / "deploy" / script).read_text().replace(directory, str(home)).replace("[[ $EUID -eq 0 ]]", "true")
                copy = self.base / script.removesuffix(".sh") / "deploy" / script
                copy.parent.mkdir(parents=True)
                copy.write_text(body)
                (copy.parent / "rollback-kiosk.sh").write_text('echo "ROLLBACK-KIOSK $1" >&2; exit 1\n')
                inside = home / "20261027T000000.000000Z.abc123"
                inside.mkdir()
                outside = self.base / "agent-snapshot"
                outside.mkdir(exist_ok=True)
                link = home / "link"
                link.symlink_to(outside)
                env = {**self.env, "FAKE_ROOT_TREE": str(backups)}

                def run(snapshot, environment=env):
                    return subprocess.run(["bash", str(copy), *flags, str(snapshot)], env=environment, text=True, capture_output=True, check=False)

                for snapshot in (outside, link, home, inside / "nested", backups):
                    result = run(snapshot)
                    self.assertEqual(result.returncode, 1)
                    self.assertRegex(result.stderr, "Not an installer snapshot|No snapshot directory", snapshot)
                    self.assertNotIn(passed, result.stderr)
                # Control: the root-owned installer snapshot passes and reaches the snapshot's own validation.
                result = run(inside)
                self.assertIn(passed, result.stderr)
                if flags:
                    self.assertIn(f"ROLLBACK-KIOSK {inside}", result.stderr)
                # A writable snapshot home is refused even for a snapshot inside it.
                home.chmod(0o777)
                self.assertRegex(run(inside).stderr, "Not an installer snapshot")
                home.chmod(0o755)
                # Without the root stand-in the same snapshot is owned by a non-root user.
                (self.base / "bin/stat").rename(self.base / "stat.off")
                self.assertRegex(run(inside).stderr, "Not an installer snapshot")
                (self.base / "stat.off").rename(self.base / "bin/stat")


if __name__ == "__main__":
    unittest.main()
