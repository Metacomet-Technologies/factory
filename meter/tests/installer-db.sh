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
[[ $(meter_sqlite "$temp/swapped.db" 'PRAGMA user_version;') == 2 ]]
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
# A committed writer can exit without sqlite3_close(), just like the detached
# legacy writer at process exit. Reading only the main file must miss its row.
crashed=$temp/crashed.db
sqlite3 "$crashed" < "$repo/meter/tests/fixtures/legacy.sql"
python3 - "$crashed" <<'PY'
import json, os, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("PRAGMA journal_mode=WAL")
db.execute("INSERT INTO requests(id,record) VALUES (?,?)", (7, json.dumps(dict(
    id=0, ts=1791676800000, endpoint="/api/chat", model="synthetic", latency_ms=1.5,
    status=502, stream=False, client_ip="127.0.0.1", client_hostname="fixture",
    prompt_eval_count=13, eval_count=7))))
db.commit()
os._exit(0)
PY
[[ -s "$crashed-wal" ]]
[[ $(sqlite3 -readonly "file:$crashed?immutable=1" 'SELECT COUNT(*) FROM requests;') == 0 ]]
[[ $(counts "$crashed") == $'1\n0' ]]
python3 - "$repo/deploy/install-meter.sh" "$crashed" <<'PY'
import sqlite3, subprocess, sys
reader = sqlite3.connect(f"file:{sys.argv[2]}?mode=ro", uri=True)
reader.execute("BEGIN")
reader.execute("SELECT COUNT(*) FROM requests").fetchone()
for probe in ("", "fuser() { return 1; }"):
    # The second case deliberately bypasses the process probe to exercise
    # SQLite's busy result, including busy=1 when all frames were copied.
    result = subprocess.run(["bash", "-c", '''
source "$1"
sudo() { [[ $1 == -u && $2 == meter ]] || return 1; shift 2; "$@"; }
''' + probe + '\ncheckpoint_meter_db "$2"', "test", *sys.argv[1:]],
        text=True, capture_output=True, timeout=10)
    print(result.stdout, end="")
    print(result.stderr, end="", file=sys.stderr)
    assert result.returncode != 0, "Checkpoint accepted an active reader"
    assert "still open" in result.stderr or "checkpoint incomplete" in result.stderr
reader.close()
PY
checkpoint_meter_db "$crashed"
[[ ! -s "$crashed-wal" ]]
[[ $(sqlite3 -readonly "file:$crashed?immutable=1" 'SELECT COUNT(*) FROM requests;') == 1 ]]
[[ $(counts "$crashed") == $'1\n0' ]]
sudo -u meter "$meter_binary" migrate --legacy "$crashed" --db "$temp/recovered.db" >/dev/null
[[ $(counts "$temp/recovered.db") == $'1\n0' ]]
[[ $(meter_sqlite "$temp/recovered.db" 'SELECT id,prompt_eval_count,eval_count,status FROM requests;') == '7|13|7|502' ]]
# v1 reruns also checkpoint; never infer pending frames from WAL size alone.
checkpoint_meter_db "$temp/recovered.db"
# MET-205: a v1 file upgrades in place (same inode) with unchanged telemetry
# counts, then reports verified rollup state; a rerun on v2 is a no-op.
v1=$temp/v1-inplace.db
sqlite3 "$v1" < "$repo/meter/src/v1.sql"
sqlite3 "$v1" "PRAGMA user_version=1; PRAGMA journal_mode=WAL;
INSERT INTO requests(ts_ms,endpoint,model,prompt_eval_count,eval_count,latency_ms,status,stream,client_ip,client_hostname)
  VALUES(7200000,'/api/chat','m',3,NULL,1.5,200,0,'127.0.0.1','fixture'),(3600000,'/api/chat',NULL,0,7,2.5,200,1,'127.0.0.1','fixture');
INSERT INTO gpu_samples(ts_ms,gpu_index,memory_used_mib,memory_total_mib,utilization_percent,temperature_c,power_w) VALUES(3600000,0,1,2,3,4,5);
INSERT INTO drop_episodes(started_at_ms,ended_at_ms,dropped_requests,dropped_gpu_samples) VALUES(1,2,3,4);" >/dev/null
sudo -u meter "$meter_binary" migrate --check-only --db "$v1" >/dev/null
inode=$(stat -c %i "$v1")
before=$(telemetry_counts "$v1")
[[ $before == $'2\n1\n1' ]]
sudo -u meter "$meter_binary" migrate --db "$v1" >/dev/null
[[ $(stat -c %i "$v1") == "$inode" && $(telemetry_counts "$v1") == "$before" ]]
[[ $(meter_sqlite "$v1" 'PRAGMA user_version;') == 2 ]]
[[ $(rollup_state "$v1" | cut -d'|' -f1,2) == $'gpu|1\nrequests|2' ]]
! rollup_state "$v1" | grep -q unverified
[[ $(meter_sqlite "$v1" 'SELECT SUM(requests) FROM request_daily;') == 2 ]]
sudo -u meter "$meter_binary" migrate --check-only --db "$v1" >/dev/null
sudo -u meter "$meter_binary" migrate --db "$v1" >/dev/null
[[ $(telemetry_counts "$v1") == "$before" ]]
printf 'Installer DB reads, sidecar modes, checkpoint recovery, immutable conversion, swap, in-place v2 upgrade, and rollback comparison passed (UID %s).\n' "$EUID"
