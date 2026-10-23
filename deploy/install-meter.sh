#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
root=$(dirname "$(dirname "$(realpath "${BASH_SOURCE[0]}")")")
check_only=0
binary=${1:-}
if [[ "$binary" == --check-only ]]; then check_only=1; binary=${2:-}; fi
destination=/usr/local/bin/meter
installed_unit=/etc/systemd/system/meter.service
db=/srv/factory/meter/meter.db
legacy=/srv/factory/meter/meter.v0.db
drop_in=/etc/systemd/system/ollama.service.d/override.conf
backup=/usr/local/lib/factory-backup
snapshot=
rollback_hint() {
    if [[ -n "$snapshot" ]]; then
        printf 'Recover with: sudo bash %q %q\n' "$root/deploy/rollback-meter-v1.sh" "$snapshot" >&2
    else
        printf 'No deployment changes made; no rollback snapshot exists.\n' >&2
    fi
}
fail() { printf 'ERROR: %s\n' "$*" >&2; rollback_hint; exit 1; }
# MET-239: refuse an artifact not built from this clean checkout. No override;
# a mismatch means rebuild. Runs before the root check and any change.
verify_artifact() {
    local name=$1 info=$2 checkout=$3 sha dirty head status
    sha=$(python3 -c 'import json, sys; v = json.loads(sys.argv[1]).get("git_sha"); print(v if isinstance(v, str) else "")' "$info" 2>/dev/null) \
        || fail "Artifact $name build info is not a JSON object; rebuild from $checkout."
    dirty=$(python3 -c 'import json, sys; print(json.dumps(json.loads(sys.argv[1]).get("git_dirty")))' "$info")
    head=$(sudo -u agent git -C "$checkout" rev-parse --short=7 HEAD) || fail "Cannot read the checkout commit: $checkout"
    status=$(sudo -u agent git -C "$checkout" status --porcelain) || fail "Cannot read the checkout status: $checkout"
    [[ -n $sha && $sha != unknown ]] || fail "Artifact $name has no build SHA (missing or unknown); rebuild from $checkout."
    [[ $dirty == false ]] || fail "Artifact $name was built from a dirty tree (git_dirty: $dirty); rebuild from a clean checkout."
    [[ -z $status ]] || fail "Checkout $checkout is dirty; commit or discard changes, then rebuild."
    [[ $sha == "$head" ]] || fail "Artifact $name built at $sha but checkout $checkout is at $head; rebuild at $head."
    printf 'Artifact %s built at %s matches checkout\n' "$name" "$sha"
}
wait_ready() {
    local url=$1 deadline=$((SECONDS + 45)) remaining
    while (( SECONDS < deadline )); do
        remaining=$((deadline - SECONDS))
        (( remaining > 2 )) && remaining=2
        if sudo -u meter curl -fs --max-time "$remaining" -o /dev/null "$url" 2>/dev/null; then break; fi
        if (( SECONDS < deadline )); then sleep 1; fi
    done
    sudo -u meter curl -fsS --max-time 2 "$url"
}
meter_sqlite() {
    sudo -u meter sqlite3 -readonly "$@"
}
counts() {
    meter_sqlite "$1" 'SELECT COUNT(*) FROM requests; SELECT COUNT(*) FROM gpu_samples;'
}
# v1+ telemetry tables that the in-place v2 upgrade must leave unchanged.
telemetry_counts() {
    meter_sqlite "$1" 'SELECT COUNT(*) FROM requests; SELECT COUNT(*) FROM gpu_samples; SELECT COUNT(*) FROM drop_episodes;'
}
rollup_state() {
    meter_sqlite "$1" "SELECT job||'|'||last_id||'|'||COALESCE(verified_at_ms,'unverified') FROM rollup_state ORDER BY job;"
}
checkpoint_meter_db() {
    local path=$1 result sidecar
    local files=("$path")
    [[ -f "$path" ]] || fail "Meter DB missing: $path"
    for sidecar in "$path-wal" "$path-shm"; do
        if [[ -e "$sidecar" ]]; then files+=("$sidecar"); fi
    done
    if command -v fuser >/dev/null; then
        if fuser "${files[@]}"; then fail 'Meter DB is still open; leave meter stopped and investigate.'; fi
    else
        printf 'fuser unavailable; relying on stopped service and SQLite checkpoint locks.\n' >&2
    fi
    result=$(sudo -u meter sqlite3 -batch -noheader -separator '|' -cmd '.timeout 5000' "$path" 'PRAGMA wal_checkpoint(TRUNCATE);') || fail 'Meter checkpoint failed; leave meter stopped and investigate.'
    printf 'Meter WAL checkpoint (busy|log|checkpointed): %s\n' "$result"
    [[ "$result" =~ ^0\|(-?[0-9]+)\|(-?[0-9]+)$ && ${BASH_REMATCH[1]} == "${BASH_REMATCH[2]}" ]] || fail 'Meter checkpoint incomplete; leave meter stopped and investigate.'
    [[ ! -s "$path-wal" ]] || fail 'Meter WAL remains non-empty after checkpoint.'
}
assert_meter_owner() {
    local path
    for path; do
        [[ ! -L "$path" && -f "$path" && $(stat -c %U:%G "$path") == meter:meter ]] || fail "Expected meter:meter regular file: $path"
    done
}
assert_meter_ready() {
    local path
    [[ -f "$1" ]] || fail "Meter DB missing: $1"
    for path in "$1" "$1-wal" "$1-shm"; do
        if [[ -e "$path" || -L "$path" ]]; then
            assert_meter_owner "$path"
            [[ $(stat -c %a "$path") == 600 ]] || fail "Expected mode 0600: $path"
        fi
    done
}
# Source only the DB helpers for non-root shell regression tests.
[[ ${BASH_SOURCE[0]} == "$0" ]] || return 0
[[ $# -eq $((1 + check_only)) ]] || fail 'Supply exactly one prebuilt binary path, optionally after --check-only.'
[[ -f "$binary" && -x "$binary" ]] || fail 'Supply an executable prebuilt meter binary.'
info=$(sudo -u agent "$binary" --build-info) || fail "meter --build-info failed; rebuild from $root."
verify_artifact meter "$info" "$root"
[[ $EUID -eq 0 ]] || fail 'Run as root: bash deploy/install-meter.sh [--check-only] <prebuilt-binary>.'
trap 'printf "ERROR: meter install failed at line %s.\n" "$LINENO" >&2; rollback_hint' ERR

# Read-only preflight: no accounts, DBs or deployment files are created here.
for command in systemctl curl sudo tailscale nvidia-smi useradd getent id install cp touch date mktemp realpath ss sqlite3 mv flock stat df awk sha256sum zstd python3 cmp chmod chown hostname env cat rm dirname bash sleep; do
    command -v "$command" >/dev/null || fail "Required command missing: $command"
done
binary=$(realpath "$binary")
[[ "$binary" != "$destination" ]] || fail 'Use a separate prebuilt binary, not the installed destination.'
"$binary" --version
for path in "$root/deploy/meter.service" "$root/deploy/set_ollama_host.py" "$drop_in" "$backup/factory-backup.sh" "$backup/restore-check.sh" /etc/factory-backup/nodes.conf; do
    [[ -f "$path" && -r "$path" ]] || fail "Required artifact missing: $path"
done
[[ $(hostname -s) == factory-gpu ]] || fail 'Meter must be deployed on factory-gpu.'
[[ -d /run/systemd/system ]] || fail 'systemd is not running.'
[[ ! -d /etc/systemd/system/meter.service.d ]] || fail 'Review meter unit drop-ins first.'
[[ -z $(systemctl show meter.service --property=DropInPaths --value) ]] || fail 'Review meter unit drop-ins first.'
enabled=$(systemctl is-enabled meter.service 2>/dev/null || true)
active=$(systemctl is-active meter.service 2>/dev/null || true)
case "$enabled" in enabled|disabled|static|indirect|not-found) ;; *) fail "Unsupported enable state: $enabled" ;; esac
case "$active" in active|inactive|failed|unknown) ;; *) fail "Transitional service state: $active" ;; esac
if [[ "$active" != active && -n $(ss -H -ltn 'sport = :11434') ]]; then fail 'Port 11434 is already in use.'; fi
systemctl is-active --quiet ollama.service
systemctl is-active --quiet tailscaled.service
if id meter >/dev/null 2>&1; then
    [[ $(id -u meter) -ne 0 ]] || fail 'meter must not be root.'
    getent group meter >/dev/null || fail 'meter group is missing.'
    sudo -u meter nvidia-smi -L
    sudo -u meter tailscale status --json >/dev/null
else
    ! getent group meter >/dev/null || fail 'meter group exists without its account.'
fi
for path in "$destination" /usr/local/bin/meter.new "$installed_unit" "$db" "$db-wal" "$db-shm" "$legacy" "$legacy-wal" "$legacy-shm" "$drop_in" /var/backups/factory-db/.backup.lock; do
    [[ ! -L "$path" && ( ! -e "$path" || -f "$path" ) ]] || fail "Unsafe file: $path"
    parent=$(dirname "$path")
    while [[ "$parent" != / ]]; do
        [[ ! -L "$parent" && ( ! -e "$parent" || -d "$parent" ) ]] || fail "Unsafe directory: $parent"
        parent=$(dirname "$parent")
    done
done
[[ ! -L /var/backups/meter && ( ! -e /var/backups/meter || -d /var/backups/meter ) ]] || fail 'Unsafe meter snapshot directory.'
# Temporary executable staging lets meter run preflight without traversing the
# agent's private checkout. No installed binary or service is changed here.
stage=$(mktemp -d /usr/local/bin/.meter-stage.XXXXXX)
migration_dir=
verification_dir=
trap 'rm -rf -- "$stage"; if [[ -n "$migration_dir" ]]; then rm -rf -- "$migration_dir"; fi; if [[ -n "$verification_dir" ]]; then rm -rf -- "$verification_dir"; fi' EXIT
chmod 0755 "$stage"
install -m 0755 "$binary" "$stage/meter"
mode=fresh
if [[ -f "$db" ]]; then
    version=$(meter_sqlite "$db" 'PRAGMA user_version;')
    case "$version" in
        0) mode=legacy; sudo -u meter "$stage/meter" migrate --legacy "$db" --check-only ;;
        # v1 upgrades in place to v2 (MET-205 rollups); v2 is a rerun.
        1) mode=v1; sudo -u meter "$stage/meter" migrate --check-only --db "$db" ;;
        2) mode=v2; sudo -u meter "$stage/meter" migrate --check-only --db "$db" ;;
        *) fail "Unsupported meter user_version: $version" ;;
    esac
else
    [[ ! -e "$db-wal" && ! -e "$db-shm" ]] || fail 'Orphan meter sidecars; recover first.'
fi
if [[ "$mode" == legacy ]]; then
    [[ -f "$destination" && -f "$installed_unit" ]] || fail 'Legacy conversion requires a previous binary and unit.'
    for suffix in '' -wal -shm; do [[ ! -e "$legacy$suffix" ]] || fail "Preserved v0 collision: $legacy$suffix"; done
fi
[[ -d /var/backups/factory-db ]] || fail 'Install MET-74 backups first.'
bytes=$(stat -c %s "$binary")
for path in "$destination" "$db" "$db-wal" "$db-shm"; do
    if [[ -f "$path" ]]; then bytes=$((bytes + $(stat -c %s "$path"))); fi
done
required=$((3 * bytes + 16777216))
for path in /srv/factory /var/backups /usr/local/bin; do
    available=$(df -Pk "$path" | awk 'NR==2 {print $4}')
    (( available * 1024 >= required )) || fail "Insufficient disk space at $path: need $required bytes."
done
if (( check_only )); then
    printf 'Check only: mode=%s user_version=%s; no service, DB or deployment file changed.\n' "$mode" "${version:-none}"
    if [[ "$mode" == v1 || "$mode" == v2 ]]; then
        printf 'Telemetry rows (requests, gpu_samples, drop_episodes):\n%s\n' "$(telemetry_counts "$db")"
    fi
    trap - ERR
    exit 0
fi

# --snapshot and restore-check local do not acquire the lock again. FD 9 stays
# open in this parent through verification; never invoke the locking backup job.
exec 9>>/var/backups/factory-db/.backup.lock
flock -n 9 || fail 'Backup or deployment is running; retry later.'
install -d -m 0700 /var/backups/meter
snapshot=$(mktemp -d "/var/backups/meter/$(date -u +%Y%m%dT%H%M%S.%NZ).XXXXXX")
printf '%s\n' "$enabled" > "$snapshot/enabled"
printf '%s\n' "$active" > "$snapshot/active"
printf '%s\n' "$mode" > "$snapshot/mode"
printf '%s\n' "${version:-none}" > "$snapshot/version"
for entry in binary unit; do
    path=$destination
    [[ "$entry" != unit ]] || path=$installed_unit
    if [[ -f "$path" ]]; then cp -p -- "$path" "$snapshot/$entry"; else touch "$snapshot/$entry.missing"; fi
done
cp -p -- "$drop_in" "$snapshot/ollama-drop-in"
touch "$snapshot/complete"
printf 'Rollback snapshot: %s\n' "$snapshot"
if [[ $(systemctl show meter.service --property=LoadState --value) != not-found ]]; then
    systemctl stop meter.service
    [[ $(systemctl show meter.service --property=MainPID --value) == 0 ]] || fail 'Meter PID remains after stop.'
fi
if [[ "$mode" == fresh ]]; then
    [[ ! -e "$db" && ! -e "$db-wal" && ! -e "$db-shm" ]] || fail 'DB appeared since preflight; review before retrying.'
fi
if [[ "$mode" != fresh ]]; then
    checkpoint_meter_db "$db"
    [[ $(meter_sqlite "$db" 'PRAGMA user_version;') == "$version" ]] || fail 'DB version changed since preflight.'
    STAMP=$(date -u +%Y%m%dT%H%M%S.%NZ)
    archive=/var/backups/factory-db/factory-gpu/meter/$STAMP.db.zst
    [[ ! -e "$archive" && ! -e "$archive.sha256" ]] || fail 'Backup stamp collision.'
    # Force installed configuration, not inherited developer overrides.
    env -u LOCAL_ROOT -u METER_DB -u BACKUP_TRANSPORT BACKUP_CONFIG=/etc/factory-backup/nodes.conf BACKUP_HOST=factory-gpu STAMP="$STAMP" bash "$backup/factory-backup.sh" --snapshot meter "$db"
    assert_meter_owner "$db"*
    [[ -f "$archive" && -f "$archive.sha256" ]] || fail 'Exact fresh MET-74 archive is missing.'
    (cd "$(dirname "$archive")" && sha256sum --strict -c "$STAMP.db.zst.sha256")
    verification_dir=$(mktemp -d /srv/factory/meter/.verify.XXXXXX)
    chown meter:meter "$verification_dir"
    zstd -q -d "$archive" -o "$verification_dir/meter.db"
    chown meter:meter "$verification_dir/meter.db"
    [[ $(meter_sqlite "$verification_dir/meter.db" 'PRAGMA integrity_check;') == ok ]] || fail 'Fresh archive integrity failed.'
    counts "$db" > "$snapshot/counts"
    [[ $(counts "$verification_dir/meter.db") == "$(cat "$snapshot/counts")" ]] || fail 'Fresh archive row counts differ.'
    env -u LOCAL_ROOT -u METER_DB BACKUP_CONFIG=/etc/factory-backup/nodes.conf BACKUP_HOST=factory-gpu bash "$backup/restore-check.sh" local
    # Capture the stopped generation after all WAL-aware inspections. Conversion
    # below is immutable and leaves these exact bytes and file set untouched.
    source_name=meter.db
    [[ "$mode" != legacy ]] || source_name=meter.v0.db
    for suffix in '' -wal -shm; do
        if [[ -f "$db$suffix" ]]; then cp -p -- "$db$suffix" "$snapshot/$source_name$suffix"; fi
    done
fi
touch "$snapshot/db-ready"
if ! id meter >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin meter
fi
install -d -o meter -g meter -m 0750 /srv/factory/meter
started=$(date +%s%3N)
if [[ "$mode" == fresh || "$mode" == legacy ]]; then
    migration_dir=$(mktemp -d /srv/factory/meter/.migrate.XXXXXX)
    chown meter:meter "$migration_dir"
    if [[ "$mode" == legacy ]]; then
        sudo -u meter "$stage/meter" migrate --legacy "$db" --db "$migration_dir/meter.db"
        [[ $(counts "$migration_dir/meter.db") == "$(cat "$snapshot/counts")" ]] || fail 'Migration row counts differ.'
    else
        sudo -u meter "$stage/meter" migrate --db "$migration_dir/meter.db"
    fi
fi
# A v2 rerun changes no schema; the runtime job resumes any rollup work.
[[ "$mode" == v2 ]] || touch "$snapshot/db-changing"
if [[ "$mode" == v1 ]]; then
    # In place on the stopped, backed-up file: add v2 tables, then the
    # batched backfill and raw comparison. The file is never replaced.
    telemetry_counts "$db" > "$snapshot/telemetry-counts"
    sudo -u meter "$stage/meter" migrate --db "$db" | tee "$snapshot/upgrade.json"
    [[ $(telemetry_counts "$db") == "$(cat "$snapshot/telemetry-counts")" ]] || fail 'Upgrade changed telemetry row counts.'
fi
printf 'Migration elapsed ms: %s (mode: %s)\n' "$(( $(date +%s%3N) - started ))" "$mode"
if [[ "$mode" == legacy ]]; then
    for suffix in -wal -shm ''; do
        [[ ! -e "$legacy$suffix" ]] || fail "Preserved v0 collision: $legacy$suffix"
        if [[ -e "$db$suffix" ]]; then mv -- "$db$suffix" "$legacy$suffix"; fi
    done
    touch "$snapshot/legacy-preserved"
fi
if [[ "$mode" == fresh || "$mode" == legacy ]]; then
    [[ ! -e "$db" && ! -e "$db-wal" && ! -e "$db-shm" ]] || fail 'DB appeared before swap.'
    for suffix in -wal -shm ''; do
        if [[ -e "$migration_dir/meter.db$suffix" ]]; then mv -- "$migration_dir/meter.db$suffix" "$db$suffix"; fi
    done
fi
[[ $(meter_sqlite "$db" 'PRAGMA user_version;') == 2 ]] || fail 'Expected meter schema v2.'
[[ $(meter_sqlite "$db" 'PRAGMA integrity_check;') == ok ]] || fail 'Meter DB integrity failed.'
if [[ "$mode" == legacy ]]; then
    [[ $(counts "$db") == "$(cat "$snapshot/counts")" ]] || fail 'Migration row counts differ.'
fi
for path in "$db" "$db-wal" "$db-shm"; do
    if [[ -e "$path" ]]; then assert_meter_owner "$path"; chmod 0600 "$path"; fi
done
install -m 0755 "$stage/meter" /usr/local/bin/meter.new
mv -f -- /usr/local/bin/meter.new "$destination"
install -m 0644 "$root/deploy/meter.service" "$installed_unit"
python3 "$root/deploy/set_ollama_host.py" "$drop_in" 127.0.0.1:11435
systemctl daemon-reload
if cmp -s "$drop_in" "$snapshot/ollama-drop-in"; then
    printf 'Ollama unchanged, not restarted\n'
else
    systemctl restart ollama.service
    wait_ready http://127.0.0.1:11435/api/version
fi
systemctl enable meter.service
assert_meter_ready "$db"
systemctl start meter.service
wait_ready http://127.0.0.1:11434/meter/health
wait_ready http://127.0.0.1:11434/api/version
sudo -u meter nvidia-smi -L
tailscale_status=$(sudo -u meter tailscale status --json)
[[ -n "$tailscale_status" ]] || fail 'Tailscale returned empty status for meter.'
printf '%s\n' "${tailscale_status:0:1}"
sudo -u meter curl -fsS --max-time 10 http://127.0.0.1:11434/meter/gpu | python3 -c '
import json, sys
data = json.load(sys.stdin)
fields = ("memory_used_mib", "memory_total_mib", "utilization_percent", "temperature_c", "power_w")
if not data.get("gpus") or any(gpu.get(field) is None for gpu in data["gpus"] for field in fields):
    sys.exit("ERROR: /meter/gpu contains missing or null GPU fields")
print(json.dumps(data, indent=2))
'
systemctl is-active --quiet meter.service
printf 'Rollup state (job|last_id|verified_at_ms):\n%s\n' "$(rollup_state "$db")"
if [[ "$mode" == v1 || "$mode" == v2 ]]; then
    [[ $(meter_sqlite "$db" 'SELECT COUNT(*) FROM rollup_state WHERE verified_at_ms IS NOT NULL;') == 2 ]] || fail 'Meter rollups are not verified.'
fi
printf '\nMeter v2 installed; service-user NVIDIA/Tailscale and live GPU checks passed.\n'
