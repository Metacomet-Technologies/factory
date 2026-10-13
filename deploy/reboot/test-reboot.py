#!/usr/bin/env python3
"""No-root contract checks with fake filesystems and commands, never host reboots."""

import concurrent.futures
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time

HERE = Path(__file__).resolve().parent
NOW = 1_791_799_200_000  # 2026-10-12 10:00 UTC (06:00 New York)
RUNNER = ("/home/agent/.local/bin/amp --no-tui --runner-id factory-gpu --dir /home/agent/work "
          "--discover-dirs=/home/agent/work --remote-control-terminal --amp-env "
          "--runner-account-email devon@metacomet.tech")
PLUGIN = ("/home/agent/.amp/bin/amp run /tmp/amp-plugin-runtime-q517Yo/plugin-runtime.ts "
          "/home/agent/.cache/amp/global-plugins/ampcode.com/workspace/official-modes@46ba5e96083e1347/index.ts")

SHIM = r'''#!/usr/bin/python3
import json, os, sys
from pathlib import Path
fixture = Path(os.environ['REBOOT_FIXTURE'])
data = json.loads((fixture / 'commands.json').read_text())
name = Path(sys.argv[0]).name


def pick(key, value):
    # A list is a per-call sequence; the last value repeats.
    if not isinstance(value, list):
        return value
    counter = fixture / ('count-' + key)
    count = int(counter.read_text()) if counter.exists() else 0
    counter.write_text(str(count + 1))
    return value[min(count, len(value) - 1)]


with (fixture / 'calls').open('a') as log:
    log.write(name + ' ' + ' '.join(sys.argv[1:]) + '\n')
if name == 'cp':
    import subprocess
    args = sys.argv[1:]
    if '--parents' in args:
        # Relative sources avoid GNU cp's absolute ancestor handling in the mapped root.
        args = [arg.lstrip('/') if not arg.startswith('-') else arg for arg in args[:-1]] + args[-1:]
    # Host-root ancestor ownership is unmapped in this unprivileged namespace.
    sys.exit(subprocess.run([str(fixture / 'cp-real'), *args,
                             '--no-preserve=ownership'], cwd='/').returncode)
if name == 'ps':
    print(data['ps'], end='')
    print(data.get('ps_error', ''), end='', file=sys.stderr)
    sys.exit(data.get('ps_code', 0))
if name == 'curl':
    print(data['meter'])
    sys.exit(data.get('meter_code', 0))
if name == 'upsc':
    print('Init SSL without certificate database', file=sys.stderr)
    print(data['ups'])
    sys.exit(data.get('ups_code', 0))
if name == 'hostname':
    print(data['node'])
if name == 'timedatectl':
    print('NTPSynchronized=' + pick('clock', data.get('clock', 'yes')))
if name == 'systemctl':
    if sys.argv[1] == 'reboot':
        root = Path(os.environ.get('REBOOT_ROOT', '/'))
        state = json.loads((root / 'var/lib/factory-reboot/status.json').read_text())
        assert state['last_decision'] == 'rebooting' and state['mode'] == 'enforce'
    elif sys.argv[1] == 'show':
        if '--property=Version' in sys.argv:
            print('259')
        elif '--property=LoadState' in sys.argv:
            print('loaded' if Path('/etc/systemd/system', sys.argv[2]).exists() else 'not-found')
    elif sys.argv[1] == 'is-enabled':
        print('disabled')
        sys.exit(1)
    elif sys.argv[1] == 'is-active':
        state = pick(sys.argv[2], data.get('services', {}).get(sys.argv[2], 'active'))
        print(state)
        sys.exit(0 if state == 'active' else 3)
'''


with tempfile.TemporaryDirectory(prefix="factory-reboot-test ") as temporary:
    fixture = Path(temporary)
    root = fixture / "root"
    bin_dir = fixture / "bin"
    bin_dir.mkdir()
    shutil.copy2(shutil.which("cp"), fixture / "cp-real")
    for name in ("ps", "curl", "upsc", "systemctl", "timedatectl", "hostname", "cp"):
        path = bin_dir / name
        path.write_text(SHIM)
        path.chmod(0o755)
    for directory in ("var/run", "proc", "etc/factory-reboot"):
        (root / directory).mkdir(parents=True)
    config_path = root / "etc/factory-reboot/node.conf"
    config = json.loads((HERE / "factory-gpu.conf").read_text())
    config_path.write_text(json.dumps(config))
    flag = root / "var/run/reboot-required"
    status = root / "var/lib/factory-reboot/status.json"
    calls = fixture / "calls"
    commands = dict(ps=f"2481 1 {RUNNER}\n34170 2481 {PLUGIN}\n31101 1 op daemon\n",
                    meter=json.dumps([{"ts": NOW - 600_001, "endpoint": "/api/chat"}]),
                    ups="OL", node="factory-gpu")
    env = dict(os.environ, REBOOT_ROOT=str(root), REBOOT_CONFIG=str(config_path),
               REBOOT_NOW_MS=str(NOW), REBOOT_FIXTURE=str(fixture), REBOOT_POSTBOOT_WAIT_S="0",
               PATH=str(bin_dir) + os.pathsep + os.environ["PATH"])

    def run(script="reboot-check.sh", *args, updates=None, environment=None, success=True):
        if updates:
            commands.update(updates)
        (fixture / "commands.json").write_text(json.dumps(commands))
        result = subprocess.run(["bash", str(HERE / script), *args],
                                env=environment or env, text=True, capture_output=True, timeout=60)
        assert (result.returncode == 0) == success, result.stdout + result.stderr
        return json.loads(status.read_text())

    def expect(decision, reason=None, **kwargs):
        data = run(**kwargs)
        assert data["last_decision"] == decision, data
        if reason:
            assert data["last_reason"].startswith(reason), data
        assert "systemctl reboot\n" not in calls.read_text() if calls.exists() else True
        return data

    data = expect("not-needed", "reboot-required absent")
    assert data["pending_since_ms"] is None and data["consecutive_skips"] == 0
    assert data["last_busy_reason"] is None
    data = expect("not-needed", "reboot-required absent", updates={"ps": f"2481 1 {RUNNER}\n9 2481 cargo test\n"})
    assert data["last_busy_reason"] == "agent-busy: pid=9" and data["consecutive_skips"] == 0
    assert not data["alert_due"] and data["pending_since_ms"] is None
    data = expect("not-needed", updates={"meter": json.dumps([{"ts": NOW - 1, "endpoint": "/api/chat"}]),
                                         "ps": commands["ps"].replace("9 2481 cargo test\n", "")})
    assert data["last_busy_reason"] == "meter-recent", data
    commands["meter"] = json.dumps([{"ts": NOW - 600_001, "endpoint": "/api/chat"}])
    assert expect("not-needed")["last_busy_reason"] is None
    print("PASS: not-required checks record the busy reason without changing decisions or counters")

    work = root / "home/agent/work"
    worktree = work / "factory-met-999-example"
    (worktree / "src").mkdir(parents=True)
    (worktree / ".git").write_text("gitdir: /home/agent/work/factory/.git/worktrees/x\n")
    source = worktree / "src/main.rs"
    source.write_text("fn main() {}\n")
    (work / "factory/.git").mkdir(parents=True)
    (work / "factory/README.md").write_text("main checkout\n")
    (work / "other").mkdir()
    (work / "other/recent").write_text("not a factory worktree\n")

    def age(path, milliseconds):
        stamp = (NOW - milliseconds) * 1_000_000
        os.utime(path, ns=(stamp, stamp), follow_symlinks=False)

    old = 1_800_001
    for path in (source, worktree / ".git"):
        age(path, old)
    for path in (work / "factory/README.md", work / "other/recent"):
        age(path, 1)
    assert expect("not-needed")["last_busy_reason"] is None, "Main checkout and non-factory dirs are ignored"
    for path, milliseconds, busy in ((source, 60_000, True), (source, 1_800_000, True),
                                     (source, old, False), (source, -60_000, True)):
        age(path, milliseconds)
        reason = expect("not-needed")["last_busy_reason"]
        assert reason == ("agent-worktree-active: /home/agent/work/factory-met-999-example"
                          if busy else None), (milliseconds, reason)
    age(source, old)
    (worktree / ".git").write_text("gitdir: elsewhere\n")
    age(worktree / ".git", 1)
    git_dir = work / "factory-met-998-qa/.git"
    git_dir.mkdir(parents=True)
    (git_dir / "index").write_text("index\n")
    age(git_dir / "index", 1)
    assert expect("not-needed")["last_busy_reason"] is None, ".git contents are not activity"
    flag.touch()
    (work / "factory-met-998-qa/notes.md").write_text("qa\n")
    data = expect("skipped", "agent-worktree-active: /home/agent/work/factory-met-998-qa")
    assert data["last_busy_reason"] == data["last_reason"]
    shutil.rmtree(work / "factory-met-998-qa")
    assert expect("would-reboot", "all checks clear")["last_busy_reason"] is None
    print("PASS: recent factory-* worktree files block; old files, .git, the main checkout and other dirs do not")
    flag.unlink()
    expect("not-needed")
    flag.touch()
    data = expect("would-reboot")
    assert data["pending_since_ms"] == NOW and data["days_pending"] == 0
    print("PASS: not-needed clears state; exact idle runner, plugin and op daemon allow observe")

    expect("skipped", "agent-busy", updates={"ps": f"2481 1 {RUNNER}\n9 2481 cargo test\n"})
    expect("skipped", "agent-busy", updates={"ps": f"9 1 {PLUGIN}\n"})
    expect("skipped", "agent-busy", updates={"ps": f"9 1 {RUNNER} --execute work\n"})
    expect("skipped", "agent-processes-unknown", updates={"ps": "invalid output\n"})
    expect("skipped", "agent-processes-unknown", updates={"ps": "", "ps_code": 1, "ps_error": "read error"})
    expect("would-reboot", updates={"ps_error": ""})
    expect("would-reboot", updates={"ps": "31101 1 op daemon\n", "ps_code": 0})
    print("PASS: work, extra runner arguments, orphan plugin and unreadable ps block reboot")

    for ts, decision in ((NOW - 599_999, "skipped"), (NOW - 600_000, "skipped"),
                         (NOW - 600_001, "would-reboot"), (NOW + 1, "skipped")):
        expect(decision, updates={"meter": json.dumps([{"ts": ts, "endpoint": "/api/chat"}])})
    health = {"ts": NOW - 1, "endpoint": "/api/version"}
    expect("would-reboot", updates={"meter": json.dumps([health])})
    expect("would-reboot", updates={"meter": json.dumps([
        health, {"ts": NOW - 600_001, "endpoint": "/api/chat"}])})
    expect("skipped", "meter-recent", updates={"meter": json.dumps([
        health, {"ts": NOW - 599_999, "endpoint": "/api/chat"}])})
    # Use the API's public usage contract as inputs, not the reboot implementation.
    api = (HERE.parents[1] / "factory-api/src/lib.rs").read_text()
    endpoints = re.findall(r'"([^"]+)"', re.search(
        r'pub const INFERENCE_ENDPOINTS:.*?= \[(.*?)\];', api, re.S).group(1))
    for endpoint in endpoints:
        expect("skipped", "meter-recent", updates={"meter": json.dumps([
            {"ts": NOW - 1, "endpoint": endpoint}])})
    expect("would-reboot", updates={"meter": json.dumps([
        {"ts": NOW - 1, "endpoint": "/api/embeddings"}])})
    expect("skipped", "meter-unknown", updates={"meter_code": 7})
    for invalid in ("invalid JSON", '{"ts": 1}', '[{"ts": true,"endpoint":"/api/version"}]',
                    '[{}]', '[{"ts":1}]', '[{"ts":1,"endpoint":null}]'):
        expect("skipped", "meter-unknown", updates={"meter_code": 0, "meter": invalid})
    expect("would-reboot", updates={"meter": "[]"})
    print("PASS: inference-only meter checks, health rows, all usage endpoints, time boundaries and failures")

    for ups, code, decision, reason in (("OL", 0, "would-reboot", None),
                                       ("OB DISCHRG", 0, "skipped", "ups-on-battery"),
                                       ("OL OB", 0, "skipped", "ups-on-battery"),
                                       ("", 1, "skipped", "ups-unknown"),
                                       ("UNKNOWN", 0, "skipped", "ups-unknown")):
        expect(decision, reason, updates={"ups": ups, "ups_code": code})
    commands.update(ups="OL", ups_code=0, ps="9 1 cargo test\n")
    config["mode"] = "enforce"
    config_path.write_text(json.dumps(config))
    status.unlink()
    for day in range(4):
        env["REBOOT_NOW_MS"] = str(NOW + day * 86_400_000)
        data = expect("skipped")
        assert data["consecutive_skips"] == day + 1
        assert data["days_pending"] == day
        assert data["alert_due"] == (day >= 2)
        assert expect("skipped")["consecutive_skips"] == day + 1
    print("PASS: UPS OL/OB/unreadable; three skipped days alert, repeated checks do not inflate")

    (root / "proc/stat").write_text("cpu 1 2 3\nbtime 1791800000\n")
    flag.unlink()
    data = run("postboot-check.sh", updates={"clock": "no", "services": {"meter.service": "failed"}})
    assert data["pending_since_ms"] is None and data["days_pending"] == 0
    assert data["consecutive_skips"] == 0 and not data["alert_due"]
    assert data["last_boot_ms"] == 1_791_800_000_000
    assert data["postboot"]["services"]["meter.service"] == "failed"
    assert not data["postboot"]["clock_synced"]
    flag.touch()
    data = run("postboot-check.sh", updates={"clock": "yes"})
    assert data["reboot_required"] and data["pending_since_ms"] == NOW + 3 * 86_400_000
    assert data["postboot"]["clock_synced"]
    assert expect("skipped")["consecutive_skips"] == 1
    print("PASS: postboot boot timestamp, failed services, clock states and pending resolution")

    def postboot(wait, **updates):
        for counter in fixture.glob("count-*"):
            counter.unlink()
        started = time.monotonic()
        data = run("postboot-check.sh", updates=updates,
                   environment=dict(env, REBOOT_POSTBOOT_WAIT_S=str(wait)))
        return data, time.monotonic() - started

    data, elapsed = postboot(60, clock=["no", "no", "yes"],
                             services={"meter.service": ["activating", "activating", "active"],
                                       "ollama.service": ["activating", "failed"]})
    assert data["postboot"]["clock_synced"], data
    assert data["postboot"]["services"]["meter.service"] == "active"
    assert data["postboot"]["services"]["ollama.service"] == "failed"
    assert 6 <= elapsed < 30, elapsed
    data, elapsed = postboot(3, clock="yes", services={"meter.service": "activating"})
    assert data["postboot"]["services"]["meter.service"] == "activating"
    assert 3 <= elapsed < 15, elapsed
    data, elapsed = postboot(3, clock="no", services={})
    assert not data["postboot"]["clock_synced"] and 3 <= elapsed < 15, elapsed
    commands.update(clock="yes", services={})
    print("PASS: postboot waits for a late clock and activating services, bounded by the deadline")

    flag.unlink()
    expect("not-needed")
    flag.touch()
    data = run(updates={"ps": "", "meter": "[]", "ups": "OL", "ups_code": 0})
    assert data["last_decision"] == "rebooting" and calls.read_text().count("systemctl reboot\n") == 1
    run("reboot-check.sh", "--mode", "observe")
    assert calls.read_text().count("systemctl reboot\n") == 1
    config["mode"] = "observe"
    config_path.write_text(json.dumps(config))
    calls.write_text("")
    print("PASS: enforce calls only fake reboot after status publication; explicit observe never reboots")

    failures = []
    stop = threading.Event()

    def reader():
        while not stop.is_set():
            try:
                data = json.loads(status.read_text())
                assert set(data) == {"mode", "reboot_required", "pending_since_ms", "days_pending",
                                     "consecutive_skips", "alert_due", "last_check_ms", "last_decision",
                                     "last_reason", "last_busy_reason", "last_boot_ms", "postboot"}
            except Exception as error:
                failures.append(error)
                break

    thread = threading.Thread(target=reader)
    thread.start()
    try:
        # Keep the fake command fixture immutable while concurrent real scripts run.
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(subprocess.run, ["bash", str(HERE / "reboot-check.sh")],
                                   env=env, capture_output=True, timeout=60) for _ in range(12)]
            assert all(future.result().returncode == 0 for future in futures)
    finally:
        stop.set()
        thread.join()
    assert not failures, failures
    assert {p.name for p in status.parent.iterdir()} == {"status.json", "policy.lock"}
    print("PASS: concurrent checks serialize; readers see complete atomic JSON and no leftover temp files")

    for node, expected in (("factory-gpu", "06:00"), ("factory-console", "06:30")):
        node_config = json.loads((HERE / f"{node}.conf").read_text())
        calendar = node_config["calendar"]
        assert calendar == f"*-*-* {expected} America/New_York"
        timer = (HERE / "factory-reboot.timer").read_text().replace("@CALENDAR@", calendar)
        assert f"OnCalendar=*-*-* {expected} America/New_York" in timer
        assert "Persistent=false" in timer and "RandomizedDelaySec=0" in timer
        config_path.write_text(json.dumps(node_config))
        runner = RUNNER.replace("factory-gpu", node)
        plugin = PLUGIN.replace("q517Yo", "OuJYUh" if node == "factory-console" else "q517Yo")
        expect("would-reboot", updates={"ps": f"4909 1 {runner}\n138429 4909 {plugin}\n"})
        updated_plugin = plugin.replace("OuJYUh", "NewSuffix99").replace(
            "q517Yo", "NewSuffix99").replace("46ba5e96083e1347", "012345abcdef")
        expect("would-reboot", updates={"ps": f"4909 1 {runner}\n138429 4909 {updated_plugin}\n"})
        expect("skipped", "agent-busy", updates={"ps": f"4909 1 {runner}\n"
               "138429 4909 /home/agent/.amp/bin/amp run /home/agent/work/task.ts\n"})
        expect("skipped", "agent-busy", updates={"ps": f"4909 1 {runner}\n138429 1 {updated_plugin}\n"})
        if node == "factory-console":
            expect("skipped", "agent-busy", updates={"ps": "31101 1 op daemon\n"})
            calls.write_text("")
            data = expect("would-reboot", updates={"ps": f"4909 1 {runner}\n138429 4909 {updated_plugin}\n",
                          "meter_code": 7, "ups_code": 1})
            assert "curl " not in calls.read_text() and "upsc " not in calls.read_text()
    print("PASS: both node calendars and update-safe idle allowlists; other Amp work blocks; console excludes op/meter/UPS")

    # Optional stronger installer check: real scripts in a root user namespace,
    # with a read-only host and every writable destination/command replaced.
    bwrap = shutil.which("bwrap")
    probe = subprocess.run([bwrap, "--ro-bind", "/", "/", "--unshare-user", "--uid", "0",
                            "--gid", "0", "--", "/bin/true"], capture_output=True) if bwrap else None
    if probe is None or probe.returncode:
        print("SKIP: isolated installer execution requires usable bwrap (decision checks all passed)")
    else:
        # Hide host homes so real agent worktrees cannot make the isolated probe busy.
        artifacts = fixture / "artifacts"
        shutil.copytree(HERE, artifacts, ignore=shutil.ignore_patterns("__pycache__"))
        for node, expected in (("factory-gpu", "06:00"), ("factory-console", "06:30")):
            isolated = fixture / node
            mounts = [bwrap, "--ro-bind", "/", "/", "--unshare-user", "--uid", "0", "--gid", "0",
                      "--unshare-uts", "--hostname", node, "--dev", "/dev", "--tmpfs", "/tmp",
                      "--tmpfs", "/home",
                      "--bind", str(fixture), str(fixture)]
            for relative in ("etc", "usr/local/lib", "var/lib", "var/backups", "run"):
                target = isolated / relative
                target.mkdir(parents=True)
                if relative == "etc":
                    (target / "systemd/system").mkdir(parents=True)
                if relative == "var/backups":
                    (target / "factory-reboot").mkdir()
                if relative == "run":
                    (target / "systemd/system").mkdir(parents=True)
                    (target / "reboot-required").touch()
                mounts += ["--bind", str(target), "/" + relative]
            for name in ("ps", "curl", "upsc", "systemctl", "timedatectl", "cp"):
                destination = shutil.which(name, path="/usr/sbin:/usr/bin:/sbin:/bin")
                if destination:
                    mounts += ["--ro-bind", str(bin_dir / name), destination]
                elif name == "upsc":
                    mounts += ["--ro-bind", str(bin_dir), "/usr/sbin"]
                else:
                    raise AssertionError(f"Missing namespace command: {name}")
            commands.update(node=node, ps="", meter="[]", meter_code=0, ups="OL", ups_code=0)
            (fixture / "commands.json").write_text(json.dumps(commands))
            calls.write_text("")
            poisoned = dict(env, REBOOT_ROOT="/must-not-exist", REBOOT_CONFIG="/must-not-exist", REBOOT_NOW_MS="bad")

            def installer(script, *args, success=True):
                result = subprocess.run(mounts + ["--", "bash", str(artifacts / script), *args],
                                        env=poisoned, text=True, capture_output=True, timeout=60)
                assert (result.returncode == 0) == success, str(result.returncode) + result.stdout + result.stderr + calls.read_text()
                return result

            installer("install-reboot-policy.sh", "--node", "wrong", success=False)
            other = "factory-console" if node == "factory-gpu" else "factory-gpu"
            installer("install-reboot-policy.sh", "--node", other, success=False)
            assert not list((isolated / "var/backups/factory-reboot").iterdir())
            installer("install-reboot-policy.sh", "--node", node)
            installed_config = isolated / "etc/factory-reboot/node.conf"
            installed_status = isolated / "var/lib/factory-reboot/status.json"
            installed_timer = isolated / "etc/systemd/system/factory-reboot.timer"
            assert f"OnCalendar=*-*-* {expected} America/New_York" in installed_timer.read_text()
            wants = installed_timer.parent / "multi-user.target.wants"
            wants.mkdir()
            (wants / "factory-postboot.service").symlink_to("../factory-postboot.service")
            verified = subprocess.run(mounts + ["--", "systemd-analyze", "verify", "--man=no",
                                      "/etc/systemd/system/factory-reboot.service",
                                      "/etc/systemd/system/factory-reboot.timer",
                                      "/etc/systemd/system/factory-postboot.service"],
                                      text=True, capture_output=True, timeout=60)
            assert verified.returncode == 0, verified.stdout + verified.stderr
            local = json.loads(installed_config.read_text())
            local["agent_allowlist"].append({"args": "local idle daemon"})
            installed_config.write_text(json.dumps(local))
            before = {p: p.stat().st_mtime_ns for folder in (isolated / "usr/local/lib/factory-reboot",
                      isolated / "etc/systemd/system") for p in folder.iterdir() if p.is_file()}
            installer("install-reboot-policy.sh", "--node", node, "--mode", "enforce")
            assert json.loads(installed_config.read_text())["mode"] == "enforce"
            assert json.loads(installed_config.read_text())["agent_allowlist"][-1] == {"args": "local idle daemon"}
            assert json.loads(installed_status.read_text())["mode"] == "observe"
            assert json.loads(installed_status.read_text())["last_decision"] == "would-reboot"
            assert all(p.stat().st_mtime_ns == stamp for p, stamp in before.items())
            assert "systemctl reboot\n" not in calls.read_text()
            snapshots = list((isolated / "var/backups/factory-reboot").iterdir())
            assert len(snapshots) == 2
            assert any((p / "etc/factory-reboot/node.conf").exists() for p in snapshots)
            installer("install-reboot-policy.sh", "--node", node, "--mode", "enforce", "--replace-config")
            expected_config = json.loads((HERE / f"{node}.conf").read_text())
            expected_config["mode"] = "enforce"
            assert json.loads(installed_config.read_text()) == expected_config
            replacement = set((isolated / "var/backups/factory-reboot").iterdir()) - set(snapshots)
            assert len(replacement) == 1
            saved_config = replacement.pop() / "etc/factory-reboot/node.conf"
            assert json.loads(saved_config.read_text()) == dict(local, mode="enforce")
            assert all(p.stat().st_mtime_ns == stamp for p, stamp in before.items())
            installer("rollback-reboot-policy.sh")
            assert "systemctl disable factory-reboot.timer\n" in calls.read_text()
            assert "systemctl disable factory-postboot.service\n" in calls.read_text()
            installer("rollback-reboot-policy.sh")
            assert installed_status.exists() and not installed_timer.exists() and not installed_config.exists()
            assert not (isolated / "usr/local/lib/factory-reboot").exists()
        print("PASS: both isolated installers; preserved/replaced config, snapshots, mode-only reruns, overrides and rollback")
