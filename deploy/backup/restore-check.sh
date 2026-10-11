#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
here=$(dirname "$(realpath "$0")")
# shellcheck source=deploy/backup/nodes.conf
source "${BACKUP_CONFIG:-$here/nodes.conf}"
[[ $# -le 1 ]] || { echo 'Usage: restore-check.sh [local|replica|all]' >&2; exit 1; }
mode=${1:-all}
case "$mode" in local|replica|all) ;; *) echo 'Expected local, replica, or all' >&2; exit 1 ;; esac
temp=$(mktemp -d)
trap 'rm -rf -- "$temp"' EXIT
check() {
    local directory=$1 name=$2 latest
    latest=$(find "$directory" -maxdepth 1 -type f -name '*.db.zst' -printf '%f\n' | LC_ALL=C sort | tail -n 1)
    [[ -n "$latest" ]] || { printf 'No copy for %s\n' "$directory" >&2; return 1; }
    (cd "$directory" && sha256sum --strict -c "$latest.sha256")
    zstd -q -d "$directory/$latest" -o "$temp/copy.db" -f
    python3 - "$temp/copy.db" "$name" <<'PY'
import pathlib
import sqlite3
import sys

with sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri() + "?mode=ro", uri=True) as db:
    result = [row[0] for row in db.execute("PRAGMA integrity_check")]
    if result != ["ok"]:
        raise RuntimeError(f"{sys.argv[2]}: integrity_check: {result}")
    print(f"{sys.argv[2]}: integrity_check=ok")
    for (name,) in db.execute("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name"):
        quoted = '"' + name.replace('"', '""') + '"'
        count = db.execute(f"SELECT count(*) FROM {quoted}").fetchone()[0]
        print(f"  {name}: {count} rows")
PY
}
if [[ "$mode" != replica ]]; then
    for entry in "${DBS[@]}"; do
        name=${entry%%:*}
        check "$LOCAL_ROOT/$BACKUP_HOST/$name" "$BACKUP_HOST/$name"
    done
fi
if [[ "$mode" != local ]]; then
    for name in "${PEER_DBS[@]}"; do
        check "$REPLICA_ROOT/$PEER/$name" "$PEER/$name"
    done
fi
