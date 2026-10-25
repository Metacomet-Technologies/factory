#!/usr/bin/env python3
"""Optional age-encrypted S3 snapshot transfer; restores only into private scratch.

Runtime dependencies: boto3==1.43.118, pyrage==1.4.0. Provision separately;
the scheduled backup never installs dependencies or discovers AWS credentials.
"""

import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
from urllib.parse import urlsplit


STAMP = r"\d{8}T\d{6}\.\d{9}Z"
NAME = r"[a-z0-9][a-z0-9-]{0,62}"
KEY = rf"v1/(daily|archive)/({NAME})/({NAME})/({STAMP})\.tar\.age"
MAX_OBJECT = 4 * 1024**3  # Single PUT, below the S3 5 GiB limit.


def checksum(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def verify(path):
    expected = f"{checksum(path)}  {path.name}\n"
    if Path(str(path) + ".sha256").read_text() != expected:
        raise ValueError("checksum mismatch")
    subprocess.run(["sha256sum", "--strict", "-c", path.name + ".sha256"],
                   cwd=path.parent, check=True, timeout=30, capture_output=True)
    print(f"{path.name}: OK", flush=True)


def client(endpoint, uploading):
    import boto3
    from botocore.config import Config

    url = urlsplit(endpoint)
    local = url.scheme == "http" and url.hostname in ("127.0.0.1", "::1")
    r2 = (url.scheme == "https" and
          re.fullmatch(r"[a-f0-9]{32}(?:\.(?:eu|us|fedramp))?\.r2\.cloudflarestorage\.com",
                       url.hostname or ""))
    if not (local or r2) or url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
        raise ValueError("expected R2 HTTPS endpoint or loopback test endpoint")
    credentials = json.loads((Path(os.environ["CREDENTIALS_DIRECTORY"]) / "factory-r2").read_text())
    access, secret = credentials["access_key_id"], credentials["secret_access_key"]
    session = credentials.get("session_token")
    if not access or not secret or (uploading and not session):
        raise ValueError("upload requires action-scoped session credentials")
    return boto3.session.Session().client(
        "s3", endpoint_url=endpoint, region_name="auto",
        aws_access_key_id=access, aws_secret_access_key=secret, aws_session_token=session,
        config=Config(signature_version="s3v4", connect_timeout=5, read_timeout=30,
                      retries={"mode": "standard", "total_max_attempts": 2},
                      s3={"addressing_style": "path"},
                      request_checksum_calculation="when_required",
                      response_checksum_validation="when_required"))


def push(args):
    import pyrage

    if not re.fullmatch(NAME, args.host) or not re.fullmatch(STAMP, args.stamp):
        raise ValueError("invalid host or timestamp")
    if any(not re.fullmatch(NAME, name) for name in args.names):
        raise ValueError("invalid database name")
    recipient = pyrage.x25519.Recipient.from_str(args.recipient.read_text().strip())
    with tempfile.TemporaryDirectory(prefix="factory-r2-push-") as temp:
        root = Path(temp)
        uploads = []
        for name in args.names:
            stage = root / name
            stage.mkdir(mode=0o700)
            filename = args.stamp + ".db.zst"
            source = args.root / args.host / name / filename
            for suffix in ("", ".sha256"):
                path = Path(str(source) + suffix)
                if path.is_symlink() or not path.is_file():
                    raise ValueError("expected regular snapshot pair")
                if path.stat().st_size > (256 if suffix else MAX_OBJECT):
                    raise ValueError("snapshot pair too large")
                shutil.copyfile(path, stage / (filename + suffix))
            verify(stage / filename)
            archive = stage / (args.stamp + ".tar")
            with tarfile.open(archive, "w", format=tarfile.USTAR_FORMAT) as bundle:
                for suffix in ("", ".sha256"):
                    bundle.add(stage / (filename + suffix),
                               arcname=f"{args.host}/{name}/{filename}{suffix}")
            encrypted = Path(str(archive) + ".age")
            pyrage.encrypt_file(str(archive), str(encrypted), [recipient])
            if encrypted.stat().st_size > MAX_OBJECT:
                raise ValueError("snapshot exceeds single-PUT prototype limit")
            sidecar = Path(str(encrypted) + ".sha256")
            sidecar.write_text(f"{checksum(encrypted)}  {encrypted.name}\n")
            prefix = "archive" if args.archive else "daily"
            key = f"v1/{prefix}/{args.host}/{name}/{encrypted.name}"
            uploads.append((encrypted, sidecar, key))
        # Every pair is verified and encrypted before the first network request.
        s3 = client(args.endpoint, uploading=True)
        for encrypted, sidecar, key in uploads:
            for path, object_key in ((encrypted, key), (sidecar, key + ".sha256")):
                with path.open("rb") as body:
                    s3.put_object(Bucket=args.bucket, Key=object_key, Body=body,
                                  ContentLength=path.stat().st_size,
                                  ContentType="application/octet-stream", IfNoneMatch="*")
            print(f"Uploaded {key}", flush=True)


def download(s3, bucket, key, target, limit):
    response = s3.get_object(Bucket=bucket, Key=key)
    with contextlib.closing(response["Body"]) as body, target.open("xb") as out:
        if response["ContentLength"] > limit:
            raise ValueError("object too large")
        total = 0
        for chunk in body.iter_chunks(1024 * 1024):
            total += len(chunk)
            if total > limit:
                raise ValueError("object too large")
            out.write(chunk)


def restore(args):
    import pyrage

    match = re.fullmatch(KEY, args.key)
    if not match:
        raise ValueError("invalid snapshot key")
    _, host, name, stamp = match.groups()
    identities = [pyrage.x25519.Identity.from_str(line) for line in
                  args.identity.read_text().splitlines() if line and not line.startswith("#")]
    s3 = client(args.endpoint, uploading=False)
    with tempfile.TemporaryDirectory(prefix="factory-r2-restore-") as temp:
        root = Path(temp)
        encrypted = root / (stamp + ".tar.age")
        download(s3, args.bucket, args.key, encrypted, MAX_OBJECT)
        download(s3, args.bucket, args.key + ".sha256", Path(str(encrypted) + ".sha256"), 256)
        verify(encrypted)
        archive = root / (stamp + ".tar")
        pyrage.decrypt_file(str(encrypted), str(archive), identities)
        filename = stamp + ".db.zst"
        member_name = f"{host}/{name}/{filename}"
        with tarfile.open(archive, "r:") as bundle:
            members = [bundle.next(), bundle.next()]
            if (None in members or bundle.next() is not None
                    or {m.name for m in members} != {member_name, member_name + ".sha256"}
                    or any(not m.isfile() or m.size > (256 if m.name.endswith(".sha256") else MAX_OBJECT)
                           for m in members)):
                raise ValueError("unexpected archive members")
            for member in members:
                with bundle.extractfile(member) as source, (root / Path(member.name).name).open("xb") as out:
                    shutil.copyfileobj(source, out)
        verify(root / filename)
        restored = root / "restored.db"
        # Cap decompressed size as well as the zstd window; never open a live DB.
        with restored.open("xb") as out, subprocess.Popen(
                ["zstd", "-q", "-d", "--memory=256MB", "-c", str(root / filename)],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
            try:
                total = 0
                while chunk := process.stdout.read(1024 * 1024):
                    total += len(chunk)
                    if total > 16 * 1024**3:
                        raise ValueError("restored database too large")
                    out.write(chunk)
                if process.wait(timeout=30):
                    raise ValueError("decompression failed")
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
        with contextlib.closing(sqlite3.connect(restored.as_uri() + "?mode=ro", uri=True)) as db:
            if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise ValueError("integrity check failed")
        print(f"{host}/{name}: integrity_check=ok", flush=True)


def interrupted(_signal, _frame):
    raise TimeoutError("off-site operation interrupted")


def main():
    os.umask(0o077)
    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--bucket", required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    upload = commands.add_parser("push")
    upload.add_argument("--root", type=Path, required=True)
    upload.add_argument("--host", required=True)
    upload.add_argument("--stamp", required=True)
    upload.add_argument("--recipient", type=Path, required=True)
    upload.add_argument("--archive", action="store_true")
    upload.add_argument("names", nargs="+")
    drill = commands.add_parser("restore")
    drill.add_argument("--key", required=True)
    drill.add_argument("--identity", type=Path, required=True)
    args = parser.parse_args()
    try:
        (push if args.command == "push" else restore)(args)
    except Exception:
        # SDK/crypto errors can contain credentials, URLs or plaintext metadata.
        print(f"Off-site {args.command} failed; check config, credentials and object pair", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
