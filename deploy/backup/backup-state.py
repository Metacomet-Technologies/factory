#!/usr/bin/env python3
"""Atomic status updates and calendar-day retention for verified backup pairs."""

import datetime as dt
from contextlib import suppress
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile


def publish(path):
    destination = os.environ.get("PUBLISHED_STATUS")
    if not destination:
        return
    temp = None
    try:
        data = path.read_bytes()
        with tempfile.NamedTemporaryFile(dir=Path(destination).parent, delete=False) as out:
            temp = out.name
            out.write(data)
            os.chmod(temp, 0o640)
            shutil.chown(temp, user="root", group="factory-api")
        os.replace(temp, destination)
    except Exception as error:
        print(f"WARNING: could not publish backup status to {destination}: {error}", file=sys.stderr)
    finally:
        if temp is not None:
            with suppress(OSError):
                Path(temp).unlink(missing_ok=True)


def status(path, operation, args):
    data = json.loads(path.read_text()) if path.exists() else {}
    now = int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000)
    if operation == "attempt":
        # Status describes current origins, not retired rollback archives.
        data = {name: data[name] for name in args if name in data}
        for name in args:
            previous = data.get(name, {})
            data[name] = dict(last_success_ms=previous.get("last_success_ms"),
                              last_attempt_ms=now, size_bytes=previous.get("size_bytes"),
                              integrity=None, pushed_to_peer=False, error=None)
    elif operation == "result":
        name, size, integrity, pushed, error = args
        entry = data[name]
        entry.update(size_bytes=int(size), integrity=integrity,
                     pushed_to_peer=pushed == "true", error=error or None)
        if not error:
            entry["last_success_ms"] = now
    elif operation == "fatal":
        for entry in data.values():
            if entry["error"] in (None, "Peer push pending", "Retention pending"):
                entry["error"] = args[0]
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as out:
        json.dump(data, out, indent=2)
        out.write("\n")
        temp = out.name
    os.replace(temp, path)
    publish(path)


def prune(root, names):
    today = dt.datetime.now(dt.timezone.utc).date()
    trees = []
    for name in names:
        directory = root / name
        if root.is_symlink() or directory.is_symlink():
            raise ValueError(f"Refusing symlink tree: {directory}")
        copies = []
        for path in directory.glob("*.db.zst"):
            if path.is_symlink() or not path.is_file():
                continue
            match = re.fullmatch(r"(\d{8}T\d{6})\.\d{9}Z\.db\.zst", path.name)
            if match:
                day = dt.datetime.strptime(match[1], "%Y%m%dT%H%M%S").date()
                copies.append((path, day))
        copies.sort(key=lambda item: item[0].name, reverse=True)
        # Gate the entire host tree on complete, checksummed copies for today.
        current = next((path for path, day in copies if day == today), None)
        if current is None:
            print(f"No complete backup today for {name}; retention skipped")
            return
        checksum = Path(str(current) + ".sha256")
        if checksum.is_symlink() or not checksum.is_file():
            print(f"Missing checksum for {name}; retention skipped")
            return
        expected = checksum.read_text().strip()
        if not re.fullmatch(r"[0-9a-f]{64}  " + re.escape(current.name), expected):
            raise ValueError(f"Invalid checksum file: {checksum}")
        with current.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        if digest != expected[:64]:
            raise ValueError(f"Checksum mismatch: {current}")
        trees.append(copies)
    for copies in trees:
        daily, weekly = {}, {}
        for path, day in copies:
            checksum = Path(str(path) + ".sha256")
            # Interrupted publication must not displace a complete daily copy.
            if checksum.is_symlink() or not checksum.is_file():
                continue
            daily.setdefault(day, path)
            if day.weekday() == 6:
                weekly.setdefault(day, path)
        keep = {copies[0][0]} | set(list(daily.values())[:7] + list(weekly.values())[:4])
        for path, _ in copies:
            if path not in keep:
                path.unlink()
                Path(str(path) + ".sha256").unlink(missing_ok=True)
                print(f"Pruned {path}")


if __name__ == "__main__":
    command, location, *arguments = sys.argv[1:]
    if command == "prune":
        prune(Path(location), arguments)
    elif command == "publish":
        publish(Path(location))
    else:
        status(Path(location), command, arguments)
