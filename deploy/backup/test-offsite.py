#!/usr/bin/env python3
"""Synthetic, unprivileged integration checks; moto listens only on loopback.

uvx --from 'moto[server]==5.2.4' --with 'pyrage==1.4.0' --with 'boto3==1.43.118' python -B deploy/backup/test-offsite.py
"""

import contextlib
import datetime as dt
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

import boto3
import pyrage


HERE = Path(__file__).resolve().parent


def run(command, env, success=True):
    result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=60)
    output = result.stdout + result.stderr
    assert (result.returncode == 0) == success, output
    assert "test-secret-must-not-leak" not in output
    return output


os.umask(0o077)
with tempfile.TemporaryDirectory(prefix="factory-offsite-test ' ") as temp:
    root = Path(temp)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    endpoint = f"http://127.0.0.1:{port}"
    base_env = {key: os.environ[key] for key in ("PATH", "HOME", "LANG") if key in os.environ}
    with (root / "moto.log").open("w") as log, subprocess.Popen(
            ["uvx", "--from", "moto[server]==5.2.4", "moto_server", "-H", "127.0.0.1", "-p", str(port)],
            env=base_env, stdout=log, stderr=log) as server:
        try:
            for _ in range(300):
                assert server.poll() is None, (root / "moto.log").read_text()
                try:
                    with urllib.request.urlopen(endpoint, timeout=1):
                        break
                except urllib.error.URLError:
                    time.sleep(0.1)
            else:
                raise AssertionError("moto did not start")
            s3 = boto3.client("s3", endpoint_url=endpoint, region_name="us-east-1",
                              aws_access_key_id="testing", aws_secret_access_key="testing")
            bucket = "factory-offsite-test"
            s3.create_bucket(Bucket=bucket)
            credentials = root / "credentials"
            credentials.mkdir(mode=0o700)
            credential = credentials / "factory-r2"
            credential.write_text(json.dumps(dict(access_key_id="testing",
                                                  secret_access_key="test-secret-must-not-leak",
                                                  session_token="moto-test-session")))
            identity = pyrage.x25519.Identity.generate()
            keyfile, recipient = root / "identity.txt", root / "recipient.txt"
            keyfile.write_text(str(identity) + "\n")
            recipient.write_text(str(identity.to_public()) + "\n")
            database = root / "synthetic.db"
            with contextlib.closing(sqlite3.connect(database)) as db:
                db.executescript("PRAGMA journal_mode=WAL; CREATE TABLE events(id INTEGER PRIMARY KEY, value TEXT);"
                                 "INSERT INTO events VALUES(7, 'synthetic private data'), (29, 'second row');")
            original = database.read_bytes()
            config = root / "nodes.conf"
            config.write_text(f'''source '{HERE / "nodes.conf"}'
DBS=("meter:$METER_DB")
''')
            env = dict(base_env, BACKUP_CONFIG=str(config), BACKUP_HOST="factory-gpu",
                       BACKUP_TRANSPORT="local", LOCAL_ROOT=str(root / "local"),
                       PEER_REPLICA_ROOT=str(root / "replica"), REPLICA_ROOT=str(root / "unused"),
                       STATUS_FILE=str(root / "status.json"), PUBLISHED_STATUS="",
                       METER_DB=str(database), R2_ENDPOINT=endpoint, R2_BUCKET=bucket,
                       R2_RECIPIENT_FILE=str(recipient), R2_PYTHON=sys.executable,
                       CREDENTIALS_DIRECTORY=str(credentials), TMPDIR=str(root))
            backup = ["bash", str(HERE / "factory-backup.sh")]
            offsite = [sys.executable, str(HERE / "offsite.py"), "--endpoint", endpoint, "--bucket", bucket]

            def status():
                return json.loads((root / "status.json").read_text())

            def objects():
                return {entry["Key"] for entry in s3.list_objects_v2(Bucket=bucket).get("Contents", [])}

            run(backup, dict(env, R2_PYTHON="/missing/python"))
            assert not objects() and "r2" not in status()
            print("PASS: off by default; no off-site runtime or network needed")

            enabled = dict(env, R2_ENABLED="1")
            run(backup, enabled)
            assert status()["r2"]["error"] is None and status()["r2"]["last_success_ms"]
            keys = objects()
            assert len(keys) == 2 and all(key.startswith("v1/daily/factory-gpu/meter/") for key in keys)
            key = next(key for key in keys if key.endswith(".age"))
            snapshot_second = int(dt.datetime.strptime(Path(key).name[:15], "%Y%m%dT%H%M%S")
                                  .replace(tzinfo=dt.timezone.utc).timestamp()) * 1000
            before_recovery_point = status()["r2"]["recovery_point_ms"]
            assert snapshot_second <= before_recovery_point < snapshot_second + 1000
            assert before_recovery_point < status()["r2"]["last_success_ms"]
            encrypted = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
            assert encrypted.startswith(b"age-encryption.org/v1\n")
            assert b"synthetic private data" not in encrypted and b"SQLite format" not in encrypted
            with tarfile.open(fileobj=io.BytesIO(pyrage.decrypt(encrypted, [identity]))) as bundle:
                compressed = bundle.extractfile(next(m for m in bundle.getmembers() if m.name.endswith(".db.zst"))).read()
            restored = root / "independent.db"
            restored.write_bytes(subprocess.run(["zstd", "-q", "-d", "-c"], input=compressed,
                                                capture_output=True, check=True).stdout)
            with contextlib.closing(sqlite3.connect(restored)) as db:
                assert db.execute("SELECT * FROM events ORDER BY id").fetchall() == [
                    (7, "synthetic private data"), (29, "second row")]
            print("PASS: uploaded age ciphertext decrypts to the original asymmetric row values")

            drill = [*offsite, "restore", "--key", key, "--identity", str(keyfile)]
            print(run(drill, env), end="")
            assert database.read_bytes() == original
            assert not list(root.glob("factory-r2-*"))
            print("PASS: restore round-trip checks ciphertext, plaintext checksum and SQLite; live fixture unchanged")

            stamp = Path(key).name.removesuffix(".tar.age")
            snapshot = root / "local" / "factory-gpu" / "meter" / (stamp + ".db.zst")
            sidecar = Path(str(snapshot) + ".sha256")
            valid_checksum = sidecar.read_bytes()
            sidecar.write_text(f"{'0' * 64}  {snapshot.name}\n")
            upload = [*offsite, "push", "--root", env["LOCAL_ROOT"], "--host", "factory-gpu",
                      "--stamp", stamp, "--recipient", str(recipient)]
            run([*upload, "meter"], env, success=False)
            assert objects() == keys
            sidecar.write_bytes(valid_checksum)
            run([*upload, "meter"], env, success=False)
            assert s3.get_object(Bucket=bucket, Key=key)["Body"].read() == encrypted
            invalid_recipient = root / "invalid-recipient"
            invalid_recipient.write_text("not an age recipient")
            run([*upload[:-1], str(invalid_recipient), "meter"], env, success=False)
            assert objects() == keys
            archive = root / "local" / "factory-gpu" / "meter-v0"
            archive.mkdir()
            (archive / snapshot.name).write_bytes(snapshot.read_bytes())
            (archive / sidecar.name).write_bytes(valid_checksum)
            print(run([*upload, "--archive", "meter-v0"], env), end="")
            archive_key = key.replace("/daily/", "/archive/").replace("/meter/", "/meter-v0/")
            print(run([*offsite, "restore", "--key", archive_key, "--identity", str(keyfile)], env), end="")
            assert (archive / snapshot.name).read_bytes() == snapshot.read_bytes()
            print("PASS: bad checksum/recipient never upload; immutable archive round-trip leaves its source intact")

            wrong_key = root / "wrong.txt"
            wrong_key.write_text(str(pyrage.x25519.Identity.generate()))
            run([*drill[:-1], str(wrong_key)], env, success=False)
            altered = encrypted[:-1] + bytes([encrypted[-1] ^ 1])
            s3.put_object(Bucket=bucket, Key=key, Body=altered)
            run(drill, env, success=False)
            # Even an attacker who rewrites the outer checksum cannot forge age authentication.
            s3.put_object(Bucket=bucket, Key=key + ".sha256",
                          Body=f"{hashlib.sha256(altered).hexdigest()}  {Path(key).name}\n".encode())
            run(drill, env, success=False)
            s3.put_object(Bucket=bucket, Key=key, Body=encrypted)
            s3.put_object(Bucket=bucket, Key=key + ".sha256",
                          Body=f"{hashlib.sha256(encrypted).hexdigest()}  {Path(key).name}\n".encode())
            swapped = key.replace("/meter/", "/requests/")
            for suffix in ("", ".sha256"):
                s3.copy_object(Bucket=bucket, Key=swapped + suffix,
                               CopySource={"Bucket": bucket, "Key": key + suffix})
            run([*offsite, "restore", "--key", swapped, "--identity", str(keyfile)], env, success=False)
            run([*offsite, "restore", "--key", "../../live.db", "--identity", str(keyfile)], env, success=False)
            assert not list(root.glob("factory-r2-*"))
            print("PASS: wrong identity, corruption, forged checksum, swapped DB and unsafe key rejected")

            before_success = status()["r2"]["last_success_ms"]
            expired = []
            for tree in (root / "local", root / "replica"):
                directory = tree / "factory-gpu" / "meter"
                for age in range(1, 41):
                    stamp = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=age)).strftime("%Y%m%dT120000.000000000Z")
                    path = directory / (stamp + ".db.zst")
                    path.write_bytes(b"retention fixture")
                    Path(str(path) + ".sha256").write_text(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n")
                    if age == 40:
                        expired.append(path)
            # A real S3 denial, not a mocked subprocess or SDK exception.
            s3.put_bucket_policy(Bucket=bucket, Policy=json.dumps({"Version": "2012-10-17", "Statement": [{
                "Effect": "Deny", "Principal": "*", "Action": "s3:PutObject", "Resource": f"arn:aws:s3:::{bucket}/*"}]}))
            before_keys = objects()
            run(backup, enabled)
            assert status()["meter"]["error"] is None and status()["meter"]["pushed_to_peer"]
            assert status()["meter"]["last_success_ms"] >= status()["meter"]["last_attempt_ms"]
            assert status()["r2"]["error"].startswith("Off-site push failed")
            assert status()["r2"]["last_success_ms"] == before_success
            assert status()["r2"]["recovery_point_ms"] == before_recovery_point
            assert all(not path.exists() for path in expired)
            assert objects() == before_keys
            run(backup, dict(enabled, METER_DB=str(root / "missing.db")), success=False)
            assert status()["r2"]["error"].startswith("Off-site push failed")
            assert status()["r2"]["recovery_point_ms"] == before_recovery_point
            assert objects() == before_keys
            s3.delete_bucket_policy(Bucket=bucket)
            run(backup, enabled)
            assert status()["r2"]["error"] is None
            assert status()["r2"]["last_success_ms"] > before_success
            assert status()["r2"]["recovery_point_ms"] > before_recovery_point
            print("PASS: denied PUT preserves local/peer success and pruning; prior failure survives local failure; retry recovers")

            s3.put_bucket_policy(Bucket=bucket, Policy=json.dumps({"Version": "2012-10-17", "Statement": [{
                "Effect": "Deny", "Principal": "*", "Action": "s3:PutObject",
                "Resource": f"arn:aws:s3:::{bucket}/*.sha256"}]}))
            before_keys = objects()
            run(backup, enabled)
            partial = objects() - before_keys
            assert len(partial) == 1 and status()["r2"]["error"]
            run([*offsite, "restore", "--key", partial.pop(), "--identity", str(keyfile)], env, success=False)
            s3.delete_bucket_policy(Bucket=bucket)
            print("PASS: sidecar failure leaves an unusable partial pair and cannot mark off-site success")

            credential.unlink()
            run(backup, enabled)
            assert status()["r2"]["error"] and status()["meter"]["error"] is None
            run(backup, env)
            assert "r2" not in status()
            print("PASS: missing credential only fails off-site; disabling removes its status entry")
            print("Versions: " + ", ".join(f"{name}={importlib.metadata.version(name)}" for name in ("moto", "boto3", "pyrage")))
        finally:
            server.terminate()
            server.wait(timeout=10)
