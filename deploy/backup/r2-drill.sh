#!/usr/bin/env bash
# Operator-only, synthetic real-R2 lock/restore drill. Never run by the timer.
set -Eeuo pipefail
umask 0077
[[ $# -eq 3 ]] || { echo 'Usage: r2-drill.sh CREDENTIAL_FILE RECIPIENT_FILE IDENTITY_FILE' >&2; exit 1; }
here=$(dirname "$(realpath "$0")")
scratch=$(mktemp -d /dev/shm/factory-r2-drill.XXXXXX)
cleanup() {
    result=$?
    trap - EXIT
    if (( result == 0 )); then echo 'PASS: R2 synthetic restore and overwrite/delete lock checks';
    else echo 'FAIL: R2 drill; do not activate scheduled uploads' >&2; fi
    find "$scratch" -type f -exec shred -u -- {} + || { echo 'FAIL: scratch shredding failed' >&2; result=1; }
    rm -rf -- "$scratch"
    exit "$result"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
export TMPDIR=$scratch
/opt/factory-backup-r2/bin/python -I -B - "$here" "$scratch" "$1" "$2" "$3" <<'PY'
import argparse
import contextlib
import datetime
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys

sys.path.insert(0, sys.argv[1])
import offsite
from botocore.exceptions import ClientError

try:
    root, credential, recipient, identity = map(Path, sys.argv[2:])
    for path in (credential, identity):
        if not path.is_file() or path.stat().st_mode & 0o077:
            raise ValueError('credential and identity must be private files')
    # Credential values remain in files, not argv, environment or SDK discovery.
    shutil.copyfile(credential, root / 'factory-r2')
    os.environ['CREDENTIALS_DIRECTORY'] = str(root)
    endpoint = 'https://25c7d5cf9a2dbcd9238a95f54cfeedff.r2.cloudflarestorage.com'
    bucket = 'factory-sqlite-backups'
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%f') + '000Z'
    directory = root / 'drill-synthetic' / 'synthetic'
    directory.mkdir(parents=True)
    database = root / 'synthetic.db'
    with contextlib.closing(sqlite3.connect(database)) as db:
        db.executescript("CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT);"
                         "INSERT INTO sample VALUES(7, 'synthetic only'), (29, 'lock drill');")
        db.commit()
    compressed = directory / (stamp + '.db.zst')
    subprocess.run(['zstd', '-q', str(database), '-o', str(compressed)], check=True,
                   timeout=30, capture_output=True)
    Path(str(compressed) + '.sha256').write_text(f'{offsite.checksum(compressed)}  {compressed.name}\n')
    offsite.push(argparse.Namespace(root=root, host='drill-synthetic', stamp=stamp,
                                   recipient=recipient, archive=False, names=['synthetic'],
                                   endpoint=endpoint, bucket=bucket))
    key = f'v1/daily/drill-synthetic/synthetic/{stamp}.tar.age'
    offsite.restore(argparse.Namespace(endpoint=endpoint, bucket=bucket, key=key, identity=identity))
    print('PASS: encrypted synthetic round-trip, checksums and integrity_check=ok', flush=True)
    s3 = offsite.client(endpoint)
    # No conditional header: a 412 would prove only If-None-Match, not the lock.
    with contextlib.closing(s3.get_object(Bucket=bucket, Key=key)['Body']) as body:
        ciphertext = body.read(offsite.MAX_OBJECT + 1)
    if len(ciphertext) > offsite.MAX_OBJECT:
        raise ValueError('object too large')
    failed = False
    for operation in ('overwrite', 'delete'):
        try:
            if operation == 'overwrite':
                s3.put_object(Bucket=bucket, Key=key, Body=ciphertext)
            else:
                s3.delete_object(Bucket=bucket, Key=key)
        except ClientError as error:
            if (error.response.get('ResponseMetadata', {}).get('HTTPStatusCode') != 403
                    or error.response.get('Error', {}).get('Code') != 'AccessDenied'):
                raise
            print(f'PASS: locked object {operation} denied (403 AccessDenied)', flush=True)
        else:
            print(f'FAIL: locked object {operation} unexpectedly allowed', flush=True)
            failed = True
    if failed:
        raise ValueError('bucket lock not enforced')
    print(f'Retained synthetic object (expected 35-day lock): {key}', flush=True)
except Exception:
    print('R2 drill failed; check credentials, recipient/identity and bucket locks', file=sys.stderr)
    sys.exit(1)
PY
