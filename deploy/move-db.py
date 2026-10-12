#!/usr/bin/env python3
"""Verify MET-74 archives and compare every table before resuming writers."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile


def counts(path):
    # Only stopped, standalone snapshots/restores are passed here, never live WAL DBs.
    if path.is_symlink() or not path.is_file() or any(
        Path(str(path) + suffix).exists() or Path(str(path) + suffix).is_symlink()
        for suffix in ("-wal", "-shm")
    ):
        raise ValueError(f"Expected a standalone snapshot without sidecars: {path}")
    with sqlite3.connect(path.resolve().as_uri() + "?immutable=1", uri=True) as db:
        if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValueError(f"Integrity check failed: {path}")
        tables = {}
        for (name,) in db.execute("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name"):
            quoted = '"' + name.replace('"', '""') + '"'
            tables[name] = db.execute(f"SELECT count(*) FROM {quoted}").fetchone()[0]
        return {"user_version": db.execute("PRAGMA user_version").fetchone()[0], "tables": tables}


def verify(bundle, output):
    result = {}
    for name in ("requests", "pricing"):
        archive = bundle / f"{name}.db.zst"
        sidecar = bundle / f"{name}.db.zst.sha256"
        if any(p.is_symlink() or not p.is_file() for p in (archive, sidecar)):
            raise ValueError(f"Missing or unsafe archive pair: {archive}")
        with archive.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        if sidecar.read_text() != f"{digest}  {archive.name}\n":
            raise ValueError(f"Checksum mismatch: {archive}")
        destination = output / f"{name}.db"
        # zstd refuses existing output: do not overwrite a DB or replay its WAL.
        if any(Path(str(destination) + suffix).exists() or Path(str(destination) + suffix).is_symlink()
               for suffix in ("", "-wal", "-shm")):
            raise ValueError(f"Restore destination is not fresh: {destination}")
        subprocess.run(["zstd", "-q", "-d", str(archive), "-o", str(destination)], check=True)
        destination.chmod(0o600)
        result[name] = counts(destination) | {"sha256": digest}
    if result["pricing"]["user_version"] != 1:
        raise ValueError("MET-114 requires pricing v1; no schema conversion is performed")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("manifest", "verify", "restore", "compare"))
    parser.add_argument("bundle", type=Path)
    parser.add_argument("destination", type=Path, nargs="?")
    args = parser.parse_args()
    manifest = args.bundle / "counts.json"
    if manifest.is_symlink():
        raise ValueError(f"Unsafe manifest: {manifest}")
    if args.operation == "compare":
        if args.destination is None:
            parser.error("compare requires a stopped standalone DB directory")
        expected = json.loads(manifest.read_text())
        for name in ("requests", "pricing"):
            actual = counts(args.destination / f"{name}.db")
            if actual != {key: expected[name][key] for key in actual}:
                raise ValueError(f"Restored counts/version differ: {name}: {actual}")
        print(json.dumps(expected, indent=2))
        return
    with tempfile.TemporaryDirectory(prefix="factory-move-verify-") as temporary:
        result = verify(args.bundle, Path(temporary))
        if args.operation == "manifest":
            with manifest.open("x") as out:
                json.dump(result, out, indent=2)
                out.write("\n")
        elif result != json.loads(manifest.read_text()):
            raise ValueError("Archive counts/version/checksum differ from console manifest")
        if args.operation == "restore":
            if args.destination is None or not args.destination.is_dir():
                parser.error("restore requires an existing fresh directory")
            # Verify both archives before publishing either one. Callers keep writers stopped.
            for name in result:
                path = args.destination / f"{name}.db"
                if any(Path(str(path) + s).exists() or Path(str(path) + s).is_symlink()
                       for s in ("", "-wal", "-shm")):
                    raise ValueError(f"Restore destination is not fresh: {path}")
            for name in result:
                source = Path(temporary) / f"{name}.db"
                with source.open("rb") as src, (args.destination / source.name).open("xb") as dst:
                    shutil.copyfileobj(src, dst)
                (args.destination / source.name).chmod(0o600)
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
