#!/usr/bin/env bash
# Shared snapshot/restore contract. Never includes or removes the audit database.
units=(factory-ups-control.service factory-ups-selftest.service factory-ups-selftest.timer)
files=(usr/local/bin/factory-ups-control)
for unit in "${units[@]}"; do files+=("etc/systemd/system/$unit"); done
root=
if (( EUID != 0 )); then
    [[ -n ${UPS_CONTROL_TEST_ROOT:-} && -d $UPS_CONTROL_TEST_ROOT && $UPS_CONTROL_TEST_ROOT == /* && $UPS_CONTROL_TEST_ROOT != / ]] || { echo 'ERROR: Run as root.' >&2; exit 1; }
    root=$UPS_CONTROL_TEST_ROOT
fi
fail() { echo "ERROR: $*" >&2; exit 1; }
safe() {
    local path=$1
    while [[ $path != / && -n $path ]]; do
        [[ ! -L $path ]] || fail "Unsafe symlink: $path"
        path=$(dirname "$path")
    done
}
check_states() {
    local unit enabled active
    for unit in "${units[@]}"; do
        [[ -z $(systemctl show "$unit" -p DropInPaths --value) ]] || fail "Review drop-ins: $unit"
        enabled=$(systemctl is-enabled "$unit" 2>/dev/null || true)
        case $enabled in enabled|disabled|static|indirect|not-found) ;; *) fail "Unsupported enabled state: $unit" ;; esac
        active=$(systemctl is-active "$unit" 2>/dev/null || true)
        case $active in active|inactive|unknown) ;; *) fail "Failed/transitional state; resolve before install: $unit" ;; esac
        [[ $unit != factory-ups-selftest.service || $active != active ]] || fail 'Selftest running; retry after it finishes.'
    done
}
snapshot_files() {
    local path unit
    mkdir -p "$root/var/backups"
    snapshot=$(mktemp -d "$root/var/backups/ups-control.XXXXXX")
    for path in "${files[@]}"; do
        if [[ -e $root/$path ]]; then
            mkdir -p "$snapshot/$(dirname "$path")"
            cp -a -- "$root/$path" "$snapshot/$path"
        fi
    done
    for unit in "${units[@]}"; do
        systemctl is-enabled "$unit" > "$snapshot/$unit.enabled" 2>/dev/null || true
        systemctl is-active "$unit" > "$snapshot/$unit.active" 2>/dev/null || true
    done
    touch "$snapshot/complete"
    echo "Rollback snapshot: $snapshot"
}
stop_units() {
    local unit
    for unit in factory-ups-selftest.timer factory-ups-selftest.service factory-ups-control.service; do
        if [[ $(systemctl show "$unit" -p LoadState --value) != not-found ]]; then
            systemctl stop "$unit"
        fi
    done
}
