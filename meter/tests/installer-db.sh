#!/usr/bin/env bash
# Non-root check of the installer's real DB helpers and rollback comparison.
set -Eeuo pipefail
[[ $EUID -ne 0 ]] || { echo 'Run this test without root.' >&2; exit 1; }
repo=$(dirname "$(dirname "$(dirname "$(realpath "$0")")")")
meter_binary=$(realpath "${1:?Supply the built meter binary}")
# shellcheck source=deploy/install-meter.sh
source "$repo/deploy/install-meter.sh"
# No privilege escalation in tests: execute the requested meter command as our
# own UID. This checks DB behavior, not sudo policy or production service access.
sudo() {
    [[ $1 == -u && $2 == meter ]] || return 1
    shift 2
    "$@"
}
temp=$(mktemp -d)
trap 'rm -rf -- "$temp"' EXIT
legacy_db=$temp/meter.db
sqlite3 "$legacy_db" 'PRAGMA journal_mode=WAL;' >/dev/null
sqlite3 "$legacy_db" < "$repo/meter/tests/fixtures/legacy.sql"
[[ ! -e "$legacy_db-wal" && ! -e "$legacy_db-shm" ]]
[[ $(meter_sqlite "$legacy_db" 'PRAGMA user_version;') == 0 ]]
[[ $(counts "$legacy_db") == $'0\n0' ]]
[[ $(meter_sqlite "$legacy_db" 'PRAGMA integrity_check;') == ok ]]
sudo -u meter "$meter_binary" migrate --legacy "$legacy_db" --check-only
for suffix in '' -wal -shm; do
    [[ $(stat -c %u:%g:%a "$legacy_db$suffix") == "$(id -u):$(id -g):600" ]]
done
[[ ! -s "$legacy_db-wal" ]]
mkdir "$temp/snapshot"
cp -p "$legacy_db"* "$temp/snapshot/"
sudo -u meter "$meter_binary" migrate --legacy "$legacy_db" --db "$temp/v1.db" >/dev/null
for suffix in '' -wal -shm; do cmp "$legacy_db$suffix" "$temp/snapshot/meter.db$suffix"; done
[[ $(counts "$temp/v1.db") == $'0\n0' ]]
for suffix in -wal -shm ''; do mv "$temp/v1.db$suffix" "$temp/swapped.db$suffix"; done
[[ $(meter_sqlite "$temp/swapped.db" 'PRAGMA user_version;') == 1 ]]
[[ $(meter_sqlite "$temp/swapped.db" 'PRAGMA integrity_check;') == ok ]]
for suffix in '' -wal -shm; do
    [[ $(stat -c %u:%g:%a "$temp/swapped.db$suffix") == "$(id -u):$(id -g):600" ]]
done
if [[ $(id -un):$(id -gn) != meter:meter ]]; then
    if (assert_meter_ready "$temp/swapped.db") >/dev/null 2>&1; then
        echo 'Readiness accepted files not owned by meter:meter.' >&2; exit 1
    fi
fi
# shellcheck source=deploy/rollback-meter-v1.sh
source "$repo/deploy/rollback-meter-v1.sh"
check_preserved_v0 "$temp/snapshot/meter.db" "$legacy_db"
rm "$legacy_db-wal" "$legacy_db-shm"
check_preserved_v0 "$temp/snapshot/meter.db" "$legacy_db"
touch "$legacy_db-wal" "$legacy_db-shm"
check_preserved_v0 "$temp/snapshot/meter.db" "$legacy_db"
rm "$temp/snapshot/meter.db-wal" "$temp/snapshot/meter.db-shm"
check_preserved_v0 "$temp/snapshot/meter.db" "$legacy_db"
for path in "$legacy_db-wal" "$legacy_db-shm" "$legacy_db"; do
    cp "$path" "$temp/saved"
    printf bad >> "$path"
    if (check_preserved_v0 "$temp/snapshot/meter.db" "$legacy_db") >/dev/null 2>&1; then
        echo "Rollback accepted differing nonempty bytes: $path" >&2; exit 1
    fi
    cp "$temp/saved" "$path"
done
printf 'Installer DB reads, sidecar modes, immutable conversion, swap, and rollback comparison passed (UID %s).\n' "$EUID"
