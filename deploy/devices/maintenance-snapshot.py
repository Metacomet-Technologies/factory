#!/usr/bin/env python3
"""Publish allowlisted, read-only node maintenance observations."""

import importlib.util
import json
import os
import re
import subprocess
import time
from pathlib import Path

# -I deliberately excludes the script directory from sys.path.
spec = importlib.util.spec_from_file_location(
    "factory_devices_smart", Path(__file__).resolve().with_name("smart-snapshot.py")
)
smart = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smart)


class ProbeError(Exception):
    pass


def run(*args, codes=(0,)):
    try:
        result = subprocess.run(
            args, capture_output=True, timeout=8, check=False,
            env={"PATH": os.environ.get("PATH", "/usr/sbin:/usr/bin:/sbin:/bin"),
                 "LC_ALL": "C"},
        )
    except FileNotFoundError:
        raise NotImplementedError from None
    if result.returncode not in codes or len(result.stdout) > smart.CAP:
        raise ProbeError
    return result.stdout.decode("utf-8", errors="strict").strip()


def probe(function):
    try:
        return {"availability": "available", **function()}
    except NotImplementedError:
        return {"availability": "unsupported"}
    except (OSError, ValueError, ProbeError, subprocess.TimeoutExpired):
        return {"availability": "error", "error": "probe failed"}


PACKAGE = re.compile(r"^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?$")


def updates():
    security = other = 0
    for line in run("apt", "list", "--upgradable").splitlines():
        if line == "Listing..." or not line.strip():
            continue
        fields = line.split()
        package, separator, origins = fields[0].partition("/")
        if not separator or not PACKAGE.fullmatch(package) or len(fields) < 3 or not origins:
            raise ProbeError
        if any("-security" in origin for origin in origins.split(",")):
            security += 1
        else:
            other += 1
    return {"security": security, "other": other}


def held():
    packages = run("apt-mark", "showhold").splitlines()
    if any(not PACKAGE.fullmatch(package) for package in packages):
        raise ProbeError
    return {"packages": sorted(set(packages))}


def auto_reboot():
    values = []
    for line in run("apt-config", "dump", "Unattended-Upgrade::Automatic-Reboot").splitlines():
        if re.match(r"^Unattended-Upgrade::Automatic-Reboot(?:\s|$)", line):
            match = re.fullmatch(r'Unattended-Upgrade::Automatic-Reboot "(true|false|1|0)";', line)
            if match is None:
                raise ProbeError
            values.append(match[1] in ("true", "1"))
    if len(values) > 1:
        raise ProbeError
    return {"value": values[0] if values else False}


def tailscale():
    prefs = json.loads(run("tailscale", "debug", "prefs"))
    auto = prefs.get("AutoUpdate") if isinstance(prefs, dict) else None
    if not isinstance(auto, dict) or any(type(auto.get(key)) is not bool for key in ("Check", "Apply")):
        raise ProbeError
    return {"check": auto["Check"], "apply": auto["Apply"]}


def services():
    states = {}
    availability = "available"
    for key, unit in (("unattended_upgrades", "unattended-upgrades.service"),
                      ("fstrim_timer", "fstrim.timer"), ("smartd", "smartmontools.service")):
        def state():
            value = run("systemctl", "is-enabled", unit, codes=(0, 1, 3, 4))
            mapped = {"enabled": "enabled", "enabled-runtime": "enabled",
                      "disabled": "disabled", "masked": "disabled",
                      "masked-runtime": "disabled", "not-found": "absent"}.get(value)
            if mapped is None:
                raise ProbeError
            return {"state": mapped}
        result = probe(state)
        states[key] = result.get("state", "unknown")
        if result["availability"] == "error" or availability == "error":
            availability = "error"
        elif result["availability"] == "unsupported":
            availability = "unsupported"
    return {"availability": availability, **states}


def journal():
    directory = smart.root() / "var/log/journal"
    if not directory.exists():
        raise NotImplementedError
    if not directory.is_dir():
        raise ProbeError
    size = 0
    # os.walk's default silently ignores unreadable directories; report errors instead.
    def fail(error):
        raise error
    for directory, _, files in os.walk(directory, onerror=fail, followlinks=False):
        for name in files:
            path = Path(directory) / name
            if not path.is_symlink():
                size += path.stat().st_size
    return {"value": size}


def main():
    group = smart.publish_group()
    payload = {"schema": 1, "observed_at_ms": int(time.time() * 1000),
               "updates": probe(updates), "held": probe(held), "services": services(),
               "unattended_auto_reboot": probe(auto_reboot),
               "tailscale_auto_update": probe(tailscale), "journal_bytes": probe(journal)}
    smart.write_snapshot(smart.root() / "var/lib/factory-devices/maintenance.json", payload, group)


if __name__ == "__main__":
    main()
