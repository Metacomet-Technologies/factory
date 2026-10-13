#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
root=$(dirname "$(dirname "$(realpath "$0")")")
binary=${1:-}
unit=$root/deploy/factory-api.service
destination=/usr/local/bin/factory-api
installed_unit=/etc/systemd/system/factory-api.service
pricing_db=/var/lib/factory-api/pricing.db
legacy_db=/var/lib/factory-api/pricing.v0.db
snapshot=

rollback_hint() {
    if [[ -n "$snapshot" ]]; then
        printf 'Recover with: sudo bash %q %q\n' "$root/deploy/rollback-factory-api.sh" "$snapshot" >&2
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
        if sudo -u factory-api curl -fs --max-time "$remaining" -o /dev/null "$url"; then break; fi
        if (( SECONDS < deadline )); then sleep 1; fi
    done
    sudo -u factory-api curl -fsS --max-time 2 "$url" | jq -e '.status == "ok"' >/dev/null || fail "Service health is not OK: $url"
}
[[ $EUID -eq 0 ]] || fail 'Run as root: bash deploy/install-factory-api.sh <prebuilt-binary>.'
[[ $# -eq 1 || ( $# -eq 2 && ( $2 == --prepare-only || $2 == --check-only ) ) ]] || fail 'Supply a prebuilt binary path and optional --prepare-only or --check-only.'
trap 'printf "ERROR: factory-api install failed at line %s.\n" "$LINENO" >&2; rollback_hint' ERR

# Complete preflight before creating the account or changing deployment files.
for command in systemctl curl sudo tailscale useradd getent id install cp touch date mktemp realpath ss sqlite3 mv jq flock stat df awk sha256sum; do
    command -v "$command" >/dev/null || fail "Required command missing: $command"
done
[[ -f "$binary" && -x "$binary" ]] || fail "Prebuilt binary missing or not executable: $binary"
[[ -f "$unit" && -r "$unit" ]] || fail "Unit template missing or unreadable: $unit"
binary=$(realpath "$binary")
[[ "$binary" != "$destination" ]] || fail 'Use a separate prebuilt binary, not the installed destination.'
for path in "$destination" "$installed_unit"; do
    [[ ! -L "$path" ]] || fail "Refusing symlink destination: $path"
    [[ ! -e "$path" || -f "$path" ]] || fail "Destination is not a regular file: $path"
done
for path in /var /var/lib /var/lib/factory-usage-trigger; do
    [[ ! -L "$path" ]] || fail "Refusing symlink: $path"
    [[ ! -e "$path" || -d "$path" ]] || fail "Not a directory: $path"
done
[[ ! -d /etc/systemd/system/factory-api.service.d ]] || fail 'Remove/review existing factory-api unit drop-ins before installing.'
[[ -d /run/systemd/system ]] || fail 'systemd is not running.'
systemctl show --property=Version --value >/dev/null
[[ -z $(systemctl show factory-api.service --property=DropInPaths --value) ]] || fail 'Existing unit drop-ins would override this deployment; review them first.'
enabled=$(systemctl is-enabled factory-api.service 2>/dev/null || true)
case "$enabled" in enabled|disabled|static|indirect|not-found) ;; *) fail "Unsupported prior enable state: $enabled (resolve masks/runtime links first)." ;; esac
active=$(systemctl is-active factory-api.service 2>/dev/null || true)
case "$active" in active|inactive|failed|unknown) ;; *) fail "Service is in a transitional state: $active" ;; esac
if [[ "$active" != active && -n $(ss -H -ltn 'sport = :8080') ]]; then
    fail 'Port 8080 is already listening while factory-api is stopped.'
fi
if id factory-api >/dev/null 2>&1; then
    [[ $(id -u factory-api) -ne 0 ]] || fail 'factory-api must not be a root account.'
    getent group factory-api >/dev/null || fail 'Existing factory-api account needs a factory-api group.'
else
    ! getent group factory-api >/dev/null || fail 'factory-api group exists without its account; resolve before installing.'
fi
systemctl is-active --quiet amp-runner.service
systemctl is-active --quiet tailscaled.service
curl -fsS --max-time 5 http://127.0.0.1:11434/meter/health

# Ordering after time-sync.target only works when a real synchronization waiter
# is enabled. Keep this boot prerequisite enabled even after API rollback.
if systemctl is-active --quiet chrony.service || systemctl is-active --quiet chronyd.service; then
    clock_wait=chrony-wait.service
else
    systemctl is-active --quiet systemd-timesyncd.service || fail 'Enable chrony or systemd-timesyncd before installing.'
    clock_wait=systemd-time-wait-sync.service
fi
[[ $(systemctl show "$clock_wait" --property=LoadState --value) == loaded ]] || fail "Install $clock_wait before installing factory-api."

# Read-only version check: never create a DB during preflight.
for path in /var/lib/factory-api "$pricing_db" "$legacy_db" "$pricing_db-wal" "$pricing_db-shm" "$legacy_db-wal" "$legacy_db-shm"; do
    [[ ! -L "$path" ]] || fail "Refusing symlink: $path"
    if [[ "$path" == /var/lib/factory-api ]]; then
        [[ ! -e "$path" || -d "$path" ]] || fail "Not a directory: $path"
    else
        [[ ! -e "$path" || -f "$path" ]] || fail "Not a regular file: $path"
    fi
done
pricing_mode=fresh
if [[ -f "$pricing_db" ]]; then
    pricing_version=$(sqlite3 -readonly "$pricing_db" 'PRAGMA user_version;')
    case "$pricing_version" in
        0) pricing_mode=legacy ;;
        1) pricing_mode=v1 ;;
        *) fail "Unsupported pricing user_version: $pricing_version" ;;
    esac
fi
if [[ "$pricing_mode" != v1 ]]; then
    for path in "$legacy_db" "$legacy_db-wal" "$legacy_db-shm"; do
        [[ ! -e "$path" ]] || fail "Legacy preservation collision: $path; recover the prior installation first."
    done
fi
if [[ "$pricing_mode" == fresh ]]; then
    [[ ! -e "$pricing_db-wal" && ! -e "$pricing_db-shm" ]] || fail 'Orphan pricing WAL/SHM; recover before installing.'
fi
if [[ "$pricing_mode" == legacy ]]; then
    [[ -f "$destination" && -f "$installed_unit" ]] || fail 'Legacy pricing requires a previous binary and unit for rollback.'
fi
[[ -d /var/backups/factory-db && ! -L /var/backups/factory-db/.backup.lock ]] || fail 'Install/review MET-74 backups before deploying.'
bytes=$(stat -c %s "$binary")
for path in "$destination" "$pricing_db" "$pricing_db-wal" "$pricing_db-shm"; do
    if [[ -f "$path" ]]; then bytes=$((bytes + $(stat -c %s "$path"))); fi
done
required=$((3 * bytes + 16777216))
for path in /var/backups /var/lib /usr/local/bin; do
    available=$(df -Pk "$path" | awk 'NR==2 {print $4}')
    (( available * 1024 >= required )) || fail "Insufficient space at $path; need $required bytes for preservation and rebuild."
done

if [[ ${2:-} == --check-only ]]; then
    echo 'Read-only factory-api installer preflight passed; no changes made.'
    exit 0
fi
# Serialize with MET-74 and other deployments without stopping its timer.
exec 9>>/var/backups/factory-db/.backup.lock
flock -n 9 || fail 'Backup or deployment is running; retry after it finishes.'
# Record the DB mode so a v1 rerun cannot pair a v1 binary with legacy data.
install -d -m 0700 /var/backups/factory-api
snapshot=$(mktemp -d "/var/backups/factory-api/$(date -u +%Y%m%dT%H%M%S.%NZ).XXXXXX")
printf '%s\n' "$enabled" > "$snapshot/enabled"
printf '%s\n' "$active" > "$snapshot/active"
printf '%s\n' "$pricing_mode" > "$snapshot/pricing-mode"
if [[ -e "$destination" ]]; then cp -p -- "$destination" "$snapshot/binary"; else touch "$snapshot/binary.missing"; fi
if [[ -e "$installed_unit" ]]; then cp -p -- "$installed_unit" "$snapshot/unit"; else touch "$snapshot/unit.missing"; fi
if [[ -d /var/lib/factory-usage-trigger ]]; then
    stat -c '%u:%g %a' /var/lib/factory-usage-trigger > "$snapshot/trigger-directory.mode"
else
    touch "$snapshot/trigger-directory.missing"
fi
touch "$snapshot/complete"
printf '\nRollback snapshot: %s\n' "$snapshot"

if ! id factory-api >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir /var/lib/factory-api --shell /usr/sbin/nologin factory-api
fi
# API is installed before usage. A missing optional ReadWritePaths entry would
# be skipped at start, leaving a later-created directory read-only until restart.
# Create it now and preserve its inode on reruns and usage installation.
install -d -o factory-api -g factory-api -m 0700 /var/lib/factory-usage-trigger
sudo -u factory-api test -w /var/lib/factory-usage-trigger
[[ $(stat -c '%U:%G %a' /var/lib/factory-usage-trigger) == 'factory-api:factory-api 700' ]]
install -d -m 0755 /usr/local/bin
# Stop before replacing files, including on systems running the old binary.
if [[ $(systemctl show factory-api.service --property=LoadState --value) != not-found ]]; then
    systemctl stop factory-api.service
fi
if [[ "$pricing_mode" == legacy ]]; then
    [[ $(sqlite3 -readonly "$pricing_db" 'PRAGMA user_version;') == 0 ]] || fail 'Pricing version changed since preflight.'
    sqlite3 -readonly "$pricing_db" ".backup '$snapshot/pricing.db'"
    [[ $(sqlite3 -readonly "$snapshot/pricing.db" 'PRAGMA integrity_check;') == ok ]] || fail 'Pricing snapshot integrity check failed.'
    sha256sum "$snapshot/pricing.db" > "$snapshot/pricing.db.sha256"
    sqlite3 -readonly "$snapshot/pricing.db" "PRAGMA user_version; SELECT 'refreshes',COUNT(*) FROM refreshes; SELECT 'price_snapshots',COUNT(*) FROM price_snapshots; SELECT 'reference_selection',COUNT(*) FROM reference_selection; SELECT 'pricing_items',COUNT(*) FROM pricing_items;" > "$snapshot/pricing-counts.txt"
    # Main file last: rollback can also recover interrupted sidecar moves.
    for suffix in -wal -shm ''; do
        [[ ! -e "$legacy_db$suffix" ]] || fail "Legacy preservation collision: $legacy_db$suffix"
        if [[ -e "$pricing_db$suffix" ]]; then mv -- "$pricing_db$suffix" "$legacy_db$suffix"; fi
    done
fi
install -m 0755 "$binary" "$destination"
install -m 0644 "$unit" "$installed_unit"
install -d -o factory-api -g factory-api -m 0750 /var/lib/factory-api
if [[ ${2:-} == --prepare-only ]]; then
    systemctl daemon-reload
    systemctl disable factory-api.service
    echo 'Prepared binary, unit, account and StateDirectory. API remains stopped; restore both databases before starting.'
    exit 0
fi
if [[ "$pricing_mode" != v1 ]]; then
    sudo -u factory-api sh -c 'umask 077; exec "$1" migrate --pricing-db "$2"' sh "$destination" "$pricing_db"
fi
[[ $(sqlite3 -readonly "$pricing_db" 'PRAGMA user_version;') == 1 ]] || fail 'Pricing migration did not produce user_version=1.'
systemctl daemon-reload
systemctl enable --now "$clock_wait"
systemctl enable factory-api.service
systemctl restart factory-api.service
wait_ready http://127.0.0.1:8080/v1/health
pricing_status=$(sudo -u factory-api curl -sS --max-time 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/v1/pricing)
[[ "$pricing_status" == 200 ]] || fail "Pricing returned HTTP $pricing_status (expected 200; empty/pending is allowed)."
sudo -u factory-api curl -fsS --max-time 10 http://127.0.0.1:8080/v1/fleet
tailscale_status=$(sudo -u factory-api tailscale status --json)
[[ -n "$tailscale_status" ]] || fail 'Tailscale returned empty status for factory-api.'
sudo -u factory-api systemctl is-active amp-runner.service
systemctl is-active --quiet factory-api.service
printf '\nFactory API installed on port 8080; health, pricing, fleet and service-user checks passed.\n'
printf '%s\n' \
    'Review refresh results, then confirm only pending selections:' \
    'sudo -u factory-api curl -fsS -X POST http://127.0.0.1:8080/v1/pricing/refresh' \
    'sudo -u factory-api curl -fsS -X POST http://127.0.0.1:8080/v1/pricing/confirm/Claude%20Sonnet' \
    'sudo -u factory-api curl -fsS -X POST http://127.0.0.1:8080/v1/pricing/confirm/ChatGPT%20mid-tier'
