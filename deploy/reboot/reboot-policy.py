#!/usr/bin/env python3
"""Needs-only reboot decisions and post-boot observations; no forced reboots."""

import argparse
import concurrent.futures
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
from zoneinfo import ZoneInfo


# factory-api/src/data.rs usage_records uses factory-api/src/lib.rs INFERENCE_ENDPOINTS.
INFERENCE_ENDPOINTS = (
    "/api/generate", "/api/chat", "/api/embed",
    "/v1/chat/completions", "/v1/completions", "/v1/embeddings",
)


def command(*args):
    return subprocess.run(args, text=True, capture_output=True, timeout=15)


def worktree_reason(root, now):
    # Dispatched builder/QA worktrees; the main checkout is /home/agent/work/factory.
    try:
        worktrees = sorted(path for path in (root / "home/agent/work").glob("factory-*")
                           if path.is_dir() and not path.is_symlink())
    except OSError:
        return "agent-worktree-unknown"

    def failed(error):
        raise error

    for worktree in worktrees:
        try:
            for directory, folders, files in os.walk(worktree, onerror=failed):
                folders[:] = [name for name in folders if name != ".git"]
                for name in files:
                    if name == ".git":  # A linked worktree's .git is a pointer file.
                        continue
                    try:
                        modified = os.lstat(os.path.join(directory, name)).st_mtime_ns // 1_000_000
                    except FileNotFoundError:
                        continue
                    # Future timestamps also block: an uncertain clock is not idle.
                    if now - modified <= 1_800_000:
                        return f"agent-worktree-active: /{worktree.relative_to(root)}"
        except FileNotFoundError:
            continue
        except OSError:
            return "agent-worktree-unknown"
    return None


def busy_reason(config, root, now):
    try:
        result = command("ps", "-u", "agent", "-ww", "-o", "pid=,ppid=,args=")
        # procps returns 1 with no output when the selection has no processes.
        if result.returncode and not (result.returncode == 1 and
                                      not result.stdout and not result.stderr):
            return "agent-processes-unknown"
        processes = {}
        for line in result.stdout.splitlines():
            pid, parent, args = line.split(None, 2)
            processes[int(pid)] = (int(parent), args)
        for pid, (parent, args) in processes.items():
            if not any(re.fullmatch(rule["args"], args) and
                       ("parent_args" not in rule or re.fullmatch(
                           rule["parent_args"], processes.get(parent, (0, ""))[1]))
                       for rule in config["agent_allowlist"]):
                return f"agent-busy: pid={pid}"
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return "agent-processes-unknown"

    reason = worktree_reason(root, now)
    if reason:
        return reason

    if config["node"] == "factory-gpu":
        try:
            result = command("curl", "-fsS", "--max-time", "5",
                             "http://127.0.0.1:11434/meter/requests?limit=1000")
            if result.returncode:
                return "meter-unknown"
            requests = json.loads(result.stdout)
            if not isinstance(requests, list) or len(requests) > 1000:
                return "meter-unknown"
            for request in requests:
                ts, endpoint = request["ts"], request["endpoint"]
                if type(ts) is not int or ts < 0 or not isinstance(endpoint, str):
                    return "meter-unknown"
                # Future timestamps also block: an uncertain clock is not idle.
                if endpoint in INFERENCE_ENDPOINTS and now - ts <= 600_000:
                    return "meter-recent"
        except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
            return "meter-unknown"
        try:
            result = command("upsc", "cyberpower@localhost", "ups.status")
            tokens = result.stdout.split()
            if result.returncode or not tokens:
                return "ups-unknown"
            if "OB" in tokens:
                return "ups-on-battery"
            if "OL" not in tokens:
                return "ups-unknown"
        except (OSError, subprocess.TimeoutExpired):
            return "ups-unknown"
    return None


def postboot_observations(config):
    # Overrides are for the no-root harness only; the installer removes them.
    allowance = float(os.environ.get("REBOOT_POSTBOOT_WAIT_S", 180))

    def wait(probe, ready):
        # Each probe gets its own allowance, so one slow probe cannot starve another.
        deadline = time.monotonic() + allowance
        while True:
            value = probe()
            remaining = deadline - time.monotonic()
            if ready(value) or remaining <= 0:
                return value
            time.sleep(min(2, remaining))

    def clock():
        result = command("timedatectl", "show", "-p", "NTPSynchronized")
        return result.returncode == 0 and result.stdout.strip() == "NTPSynchronized=yes"

    def service_state(service):
        return wait(lambda: command("systemctl", "is-active", service).stdout.strip() or "unknown",
                    lambda state: state != "activating")

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(config["services"]) + 1) as pool:
        synced = pool.submit(wait, clock, bool)
        services = {service: pool.submit(service_state, service) for service in config["services"]}
        return dict(services={service: future.result() for service, future in services.items()},
                    clock_synced=synced.result())


def write_status(path, state):
    temp = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as out:
            temp = out.name
            json.dump(state, out, indent=2)
            out.write("\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, path)
        descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if temp and os.path.exists(temp):
            os.unlink(temp)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("check", "postboot"))
    parser.add_argument("--mode", choices=("observe",))
    args = parser.parse_args()
    # Overrides are for the no-root harness only; the installer removes them.
    root = Path(os.environ.get("REBOOT_ROOT", "/"))
    config = json.loads(Path(os.environ.get(
        "REBOOT_CONFIG", root / "etc/factory-reboot/node.conf")).read_text())
    if config["node"] not in ("factory-gpu", "factory-console") or config["mode"] not in (
            "observe", "enforce"):
        raise ValueError("Invalid node or mode")
    for rule in config["agent_allowlist"]:
        re.compile(rule["args"])
        if "parent_args" in rule:
            re.compile(rule["parent_args"])
    mode = args.mode or config["mode"]
    now = int(os.environ.get("REBOOT_NOW_MS", time.time_ns() // 1_000_000))
    path = root / "var/lib/factory-reboot/status.json"
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Wait for the clock and services before locking so checks are not held up.
    observed = postboot_observations(config) if args.operation == "postboot" else None
    with (path.parent / "policy.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = json.loads(path.read_text()) if path.exists() else dict(
            pending_since_ms=None, days_pending=0, consecutive_skips=0,
            alert_due=False, last_check_ms=None, last_decision=None,
            last_reason=None, last_boot_ms=None, postboot={})
        state.setdefault("last_busy_reason", None)
        required = (root / "var/run/reboot-required").exists()
        state.update(mode=mode, reboot_required=required)
        if not required:
            state.update(pending_since_ms=None, days_pending=0,
                         consecutive_skips=0, alert_due=False)
        else:
            if state["pending_since_ms"] is None:
                state["pending_since_ms"] = now
            state["days_pending"] = max(0, (now - state["pending_since_ms"]) // 86_400_000)

        reboot = False
        if args.operation == "postboot":
            boot = next(line.split()[1] for line in (root / "proc/stat").read_text().splitlines()
                        if line.startswith("btime "))
            state["last_boot_ms"] = int(boot) * 1000
            state["postboot"] = observed
        else:
            # Record the busy check even without the marker so observe shows what enforce would see.
            busy = busy_reason(config, root, now)
            state["last_busy_reason"] = busy
            reason = busy if required else "reboot-required absent"
            if required and reason:
                zone = ZoneInfo("America/New_York")
                today = dt.datetime.fromtimestamp(now / 1000, zone).date()
                previous = state["last_check_ms"]
                day = dt.datetime.fromtimestamp(previous / 1000, zone).date() if previous else None
                if not state["consecutive_skips"] or state["last_decision"] != "skipped" or day not in (
                        today, today - dt.timedelta(days=1)):
                    state["consecutive_skips"] = 1
                elif day != today:
                    state["consecutive_skips"] += 1
                state["alert_due"] = state["consecutive_skips"] >= 3
                decision = "skipped"
            else:
                state.update(consecutive_skips=0, alert_due=False)
                decision = "not-needed" if not required else (
                    "would-reboot" if mode == "observe" else "rebooting")
                reason = reason or "all checks clear"
                reboot = decision == "rebooting"
            state.update(last_check_ms=now, last_decision=decision, last_reason=reason)
        write_status(path, state)
        print(json.dumps(state), flush=True)
        if reboot:
            os.sync()
            subprocess.run(["systemctl", "reboot"], check=True, timeout=30)


if __name__ == "__main__":
    main()
