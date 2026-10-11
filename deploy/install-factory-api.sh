#!/usr/bin/env bash
set -Eeuo pipefail
root=$(dirname "$(dirname "$(realpath "$0")")")
binary=${1:-$root/target/release/factory-api}
unit=$root/deploy/factory-api.service
destination=/usr/local/bin/factory-api
installed_unit=/etc/systemd/system/factory-api.service
snapshot=

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
wait_ready() {
    local url=$1 deadline=$((SECONDS + 45)) remaining
    while (( SECONDS < deadline )); do
        remaining=$((deadline - SECONDS))
        (( remaining > 2 )) && remaining=2
        if curl -fs --max-time "$remaining" -o /dev/null "$url"; then break; fi
        if (( SECONDS < deadline )); then sleep 1; fi
    done
    curl -fsS --max-time 2 "$url" || fail "Service did not become ready within 45s: $url"
}
[[ $EUID -eq 0 ]] || fail 'Run as root: bash deploy/install-factory-api.sh [prebuilt-binary].'
[[ $# -le 1 ]] || fail 'Expected at most one prebuilt binary path.'
trap 'printf "ERROR: factory-api install failed at line %s. Snapshot: %s. Recover with: bash deploy/rollback-factory-api.sh <snapshot>\n" "$LINENO" "${snapshot:-not created (no deployment files changed)}" >&2' ERR

# Complete preflight before creating the account or changing deployment files.
for command in systemctl curl sudo tailscale useradd getent id install cp touch date mktemp realpath ss; do
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
curl -fsS --max-time 5 http://factory-gpu:11434/meter/health

# Ordering after time-sync.target only works when a real synchronization waiter
# is enabled. Keep this boot prerequisite enabled even after API rollback.
if systemctl is-active --quiet chrony.service || systemctl is-active --quiet chronyd.service; then
    clock_wait=chrony-wait.service
else
    systemctl is-active --quiet systemd-timesyncd.service || fail 'Enable chrony or systemd-timesyncd before installing.'
    clock_wait=systemd-time-wait-sync.service
fi
[[ $(systemctl show "$clock_wait" --property=LoadState --value) == loaded ]] || fail "Install $clock_wait before installing factory-api."

# Each snapshot records missing files too; rollback never touches databases/user.
install -d -m 0700 /var/backups/factory-api
snapshot=$(mktemp -d "/var/backups/factory-api/$(date -u +%Y%m%dT%H%M%S.%NZ).XXXXXX")
printf '%s\n' "$enabled" > "$snapshot/enabled"
printf '%s\n' "$active" > "$snapshot/active"
if [[ -e "$destination" ]]; then cp -p -- "$destination" "$snapshot/binary"; else touch "$snapshot/binary.missing"; fi
if [[ -e "$installed_unit" ]]; then cp -p -- "$installed_unit" "$snapshot/unit"; else touch "$snapshot/unit.missing"; fi
touch "$snapshot/complete"
printf '\nRollback snapshot: %s\n' "$snapshot"

if ! id factory-api >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir /var/lib/factory-api --shell /usr/sbin/nologin factory-api
fi
install -d -m 0755 /usr/local/bin
# Stop before replacing files, including on systems running the old binary.
if [[ "$active" == active ]]; then systemctl stop factory-api.service; fi
install -m 0755 "$binary" "$destination"
install -m 0644 "$unit" "$installed_unit"
systemctl daemon-reload
systemctl enable --now "$clock_wait"
systemctl enable factory-api.service
systemctl restart factory-api.service
wait_ready http://127.0.0.1:8080/v1/health
curl -fsS --max-time 10 http://127.0.0.1:8080/v1/fleet
tailscale_status=$(sudo -u factory-api tailscale status --json)
[[ -n "$tailscale_status" ]] || fail 'Tailscale returned empty status for factory-api.'
sudo -u factory-api systemctl is-active amp-runner.service
systemctl is-active --quiet factory-api.service
printf '\nFactory API installed on port 8080; health, fleet and service-user checks passed.\n'
