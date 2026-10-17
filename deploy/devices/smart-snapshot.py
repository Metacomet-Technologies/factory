#!/usr/bin/env python3
"""Write a sanitized SMART snapshot. Read-only. No self-tests."""

import grp
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

CAP = 1_048_576
TIMEOUT = 8
NAME = re.compile(r"^[A-Za-z0-9]+$")
SKIP = ("loop", "ram", "fd", "dm-", "md", "zram", "nbd", "sr", "zd")


def root() -> Path:
    configured = os.environ.get("FACTORY_DEVICES_ROOT", "/")
    return Path(configured if configured else "/")


def physical(block: Path) -> list[str]:
    if not block.is_dir():
        return []
    names = []
    for entry in sorted(block.iterdir()):
        name = entry.name
        if not NAME.fullmatch(name) or name.startswith(SKIP) or (entry / "partition").exists():
            continue
        names.append(name)
    return names


def smartctl(device: str) -> dict | None:
    try:
        result = subprocess.run(
            ["smartctl", "-j", "-H", "-A", f"/dev/{device}"],
            capture_output=True,
            timeout=TIMEOUT,
            env={"PATH": os.environ.get("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")},
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    text = result.stdout[:CAP]
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def entry(name: str, parsed: dict | None) -> dict:
    if parsed is None:
        return {"kernel": name, "unsupported": True}
    smart = parsed.get("smart_status") if isinstance(parsed.get("smart_status"), dict) else {}
    passed = smart.get("passed")
    spare = None
    threshold = None
    media = None
    critical = False
    temperature = None
    attributes = parsed.get("ata_smart_attributes")
    rows = attributes.get("table") if isinstance(attributes, dict) else None
    if isinstance(rows, list):
        for row in rows:
            if not isinstance(row, dict):
                continue
            ident = row.get("id")
            raw = row.get("raw")
            value = raw.get("value") if isinstance(raw, dict) else None
            if ident == 5 and isinstance(value, (int, float)):
                media = float(value)
                critical = media > 0
            if ident == 194 and isinstance(value, (int, float)):
                temperature = float(value)
    nvme = parsed.get("nvme_smart_health_information_log")
    if isinstance(nvme, dict):
        if isinstance(nvme.get("available_spare"), (int, float)):
            spare = float(nvme["available_spare"])
        if isinstance(nvme.get("available_spare_threshold"), (int, float)):
            threshold = float(nvme["available_spare_threshold"])
        if isinstance(nvme.get("media_errors"), (int, float)):
            media = float(nvme["media_errors"])
            critical = media > 0
        if isinstance(nvme.get("temperature"), (int, float)):
            temperature = float(nvme["temperature"])
    body = {"kernel": name, "passed": passed if isinstance(passed, bool) else None}
    if spare is not None:
        body["available_spare_percent"] = spare
    if threshold is not None:
        body["spare_threshold_percent"] = threshold
    if media is not None:
        body["media_errors"] = media
        body["media_critical"] = critical
    if temperature is not None:
        body["temperature_c"] = temperature
    return body


def require_group(name: str) -> int:
    try:
        return grp.getgrnam(name).gr_gid
    except KeyError:
        print(f"{name} group is missing", file=sys.stderr)
        raise SystemExit(1) from None


def publish_group() -> int | None:
    if os.geteuid() != 0:
        return None
    return require_group("factory-api")


def write_snapshot(destination: Path, payload: dict, group: int | None = None) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".json.tmp")
    data = json.dumps(payload, sort_keys=True).encode()
    published = False
    try:
        with temporary.open("wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o640)
        if group is not None:
            os.chown(temporary, -1, group)
        os.replace(temporary, destination)
        published = True
    finally:
        if not published:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def main() -> None:
    base = root()
    destination = base / "var/lib/factory-devices/smart.json"
    group = publish_group()
    names = physical(base / "sys/block")
    if shutil_which("smartctl") is None:
        write_snapshot(
            destination,
            {"tool": "absent", "drives": [], "observed_at_ms": int(time.time() * 1000)},
            group,
        )
        return
    drives = []
    for name in names:
        parsed = smartctl(name)
        drives.append(entry(name, parsed))
    write_snapshot(
        destination,
        {"observed_at_ms": int(time.time() * 1000), "drives": drives},
        group,
    )


def shutil_which(name: str) -> str | None:
    for directory in os.environ.get("PATH", "").split(":"):
        candidate = Path(directory) / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


if __name__ == "__main__":
    main()
