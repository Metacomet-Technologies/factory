#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
root=$(dirname "$(dirname "$(realpath "$0")")")
binary=${1:-}
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
counts() {
    sqlite3 -readonly "$1" 'SELECT COUNT(*) FROM requests; SELECT COUNT(*) FROM gpu_samples;'
}
[[ $EUID -eq 0 ]] || fail 'Run as root: bash deploy/install-meter.sh <prebuilt-binary>.'
[[ $# -eq 1 ]] || fail 'Supply exactly one prebuilt binary path.'
trap 'printf "ERROR: meter install failed at line %s.\n" "$LINENO" >&2; rollback_hint' ERR

# Read-only preflight: no accounts, DBs or deployment files are created here.
for command in systemctl curl sudo tailscale nvidia-smi useradd getent id install cp touch date mktemp realpath ss sqlite3 mv flock stat df awk sha256sum zstd python3 cmp chmod chown hostname env cat rm dirname bash sleep; do
    command -v "$command" >/dev/null || fail "Required command missing: $command"
done
[[ -f "$binary" && -x "$binary" ]] || fail 'Supply an executable prebuilt meter binary.'
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
mode=fresh
if [[ -f "$db" ]]; then
    version=$(sqlite3 -readonly "$db" 'PRAGMA user_version;')
    case "$version" in
        0) mode=legacy; "$binary" migrate --legacy "$db" --check-only ;;
        1) mode=v1 ;;
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

# --snapshot and restore-check local do not acquire the lock again. FD 9 stays
# open in this parent through verification; never invoke the locking backup job.
exec 9>>/var/backups/factory-db/.backup.lock
flock -n 9 || fail 'Backup or deployment is running; retry later.'
install -d -m 0700 /var/backups/meter
snapshot=$(mktemp -d "/var/backups/meter/$(date -u +%Y%m%dT%H%M%S.%NZ).XXXXXX")
printf '%s\n' "$enabled" > "$snapshot/enabled"
printf '%s\n' "$active" > "$snapshot/active"
printf '%s\n' "$mode" > "$snapshot/mode"
for entry in binary unit; do
    path=$destination
    [[ "$entry" != unit ]] || path=$installed_unit
    if [[ -f "$path" ]]; then cp -p -- "$path" "$snapshot/$entry"; else touch "$snapshot/$entry.missing"; fi
done
cp -p -- "$drop_in" "$snapshot/ollama-drop-in"
touch "$snapshot/complete"
printf 'Rollback snapshot: %s\n' "$snapshot"
if [[ $(systemctl show meter.service --property=LoadState --value) != not-found ]]; then systemctl stop meter.service; fi
if [[ "$mode" == fresh ]]; then
    [[ ! -e "$db" && ! -e "$db-wal" && ! -e "$db-shm" ]] || fail 'DB appeared since preflight; review before retrying.'
fi
if [[ "$mode" != fresh ]]; then
    [[ $(sqlite3 -readonly "$db" 'PRAGMA user_version;') == "$version" ]] || fail 'DB version changed since preflight.'
    # Stop-time raw files are the rollback generation, including WAL/SHM.
    source_name=meter.db
    [[ "$mode" != legacy ]] || source_name=meter.v0.db
    for suffix in '' -wal -shm; do
        if [[ -f "$db$suffix" ]]; then cp -p -- "$db$suffix" "$snapshot/$source_name$suffix"; fi
    done
    STAMP=$(date -u +%Y%m%dT%H%M%S.%NZ)
    archive=/var/backups/factory-db/factory-gpu/meter/$STAMP.db.zst
    [[ ! -e "$archive" && ! -e "$archive.sha256" ]] || fail 'Backup stamp collision.'
    # Force installed configuration, not inherited developer overrides.
    env -u LOCAL_ROOT -u METER_DB -u BACKUP_TRANSPORT BACKUP_CONFIG=/etc/factory-backup/nodes.conf BACKUP_HOST=factory-gpu STAMP="$STAMP" bash "$backup/factory-backup.sh" --snapshot meter "$db"
    [[ -f "$archive" && -f "$archive.sha256" ]] || fail 'Exact fresh MET-74 archive is missing.'
    (cd "$(dirname "$archive")" && sha256sum --strict -c "$STAMP.db.zst.sha256")
    zstd -q -d "$archive" -o "$snapshot/verified.db"
    [[ $(sqlite3 -readonly "$snapshot/verified.db" 'PRAGMA integrity_check;') == ok ]] || fail 'Fresh archive integrity failed.'
    counts "$db" > "$snapshot/counts"
    [[ $(counts "$snapshot/verified.db") == "$(cat "$snapshot/counts")" ]] || fail 'Fresh archive row counts differ.'
    env -u LOCAL_ROOT -u METER_DB BACKUP_CONFIG=/etc/factory-backup/nodes.conf BACKUP_HOST=factory-gpu bash "$backup/restore-check.sh" local
fi
touch "$snapshot/db-ready"
if ! id meter >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin meter
fi
install -d -o meter -g meter -m 0750 /srv/factory/meter
# Stage outside the agent checkout, with root-owned traversable parents.
stage=$(mktemp -d /usr/local/bin/.meter-stage.XXXXXX)
migration_dir=
trap 'rm -rf -- "$stage"; if [[ -n "$migration_dir" ]]; then rm -rf -- "$migration_dir"; fi' EXIT
chmod 0755 "$stage"
install -m 0755 "$binary" "$stage/meter"
started=$(date +%s%3N)
if [[ "$mode" != v1 ]]; then
    migration_dir=$(mktemp -d /srv/factory/meter/.migrate.XXXXXX)
    chown meter:meter "$migration_dir"
    if [[ "$mode" == legacy ]]; then
        sudo -u meter "$stage/meter" migrate --legacy "$db" --db "$migration_dir/meter.db"
        [[ $(counts "$migration_dir/meter.db") == "$(cat "$snapshot/counts")" ]] || fail 'Migration row counts differ.'
    else
        sudo -u meter "$stage/meter" migrate --db "$migration_dir/meter.db"
    fi
fi
printf 'Migration elapsed ms: %s (mode: %s)\n' "$(( $(date +%s%3N) - started ))" "$mode"
touch "$snapshot/db-changing"
if [[ "$mode" == legacy ]]; then
    for suffix in -wal -shm ''; do
        [[ ! -e "$legacy$suffix" ]] || fail "Preserved v0 collision: $legacy$suffix"
        if [[ -e "$db$suffix" ]]; then mv -- "$db$suffix" "$legacy$suffix"; fi
    done
    touch "$snapshot/legacy-preserved"
fi
if [[ "$mode" != v1 ]]; then
    [[ ! -e "$db" && ! -e "$db-wal" && ! -e "$db-shm" ]] || fail 'DB appeared before swap.'
    mv -- "$migration_dir/meter.db" "$db"
fi
[[ $(sqlite3 -readonly "$db" 'PRAGMA user_version;') == 1 ]] || fail 'Expected meter schema v1.'
[[ $(sqlite3 -readonly "$db" 'PRAGMA integrity_check;') == ok ]] || fail 'Meter DB integrity failed.'
if [[ "$mode" == legacy ]]; then
    [[ $(counts "$db") == "$(cat "$snapshot/counts")" ]] || fail 'Migration row counts differ.'
fi
chown meter:meter "$db"
chmod 0600 "$db"
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
printf '\nMeter v1 installed; service-user NVIDIA/Tailscale and live GPU checks passed.\n'
