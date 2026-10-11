#!/usr/bin/env bash
set -Eeuo pipefail
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run as root: bash deploy/rollback-factory-api.sh <snapshot-directory>.'
[[ $# -eq 1 ]] || fail 'Supply the exact snapshot directory printed by the installer.'
snapshot=$1
trap 'printf "ERROR: rollback failed at line %s; snapshot retained at %s.\n" "$LINENO" "$snapshot" >&2' ERR
for command in systemctl cp rm cat; do
    command -v "$command" >/dev/null || fail "Required command missing: $command"
done
[[ -f "$snapshot/complete" && -f "$snapshot/enabled" && -f "$snapshot/active" ]] || fail 'Snapshot is incomplete.'
for name in binary unit; do
    if [[ -f "$snapshot/$name" && ! -e "$snapshot/$name.missing" ]]; then
        :
    elif [[ -f "$snapshot/$name.missing" && ! -e "$snapshot/$name" ]]; then
        :
    else
        fail "Invalid snapshot entry: $name"
    fi
done
enabled=$(cat "$snapshot/enabled")
active=$(cat "$snapshot/active")
case "$enabled" in enabled|disabled|static|indirect|not-found) ;; *) fail "Invalid enable state: $enabled" ;; esac
case "$active" in active|inactive|failed|unknown) ;; *) fail "Invalid active state: $active" ;; esac
for path in /usr/local/bin/factory-api /etc/systemd/system/factory-api.service; do
    [[ ! -L "$path" && ( ! -e "$path" || -f "$path" ) ]] || fail "Unsafe destination: $path"
done

# Installation may have failed before writing/loading the new unit.
if [[ $(systemctl show factory-api.service --property=LoadState --value) != not-found ]]; then
    systemctl stop factory-api.service
    systemctl disable factory-api.service
fi
if [[ -f "$snapshot/binary.missing" ]]; then
    rm -f -- /usr/local/bin/factory-api
else
    cp -p -- "$snapshot/binary" /usr/local/bin/factory-api
fi
if [[ -f "$snapshot/unit.missing" ]]; then
    rm -f -- /etc/systemd/system/factory-api.service
else
    cp -p -- "$snapshot/unit" /etc/systemd/system/factory-api.service
fi
systemctl daemon-reload
if [[ "$enabled" == enabled ]]; then systemctl enable factory-api.service; fi
if [[ "$active" == active ]]; then
    systemctl start factory-api.service
    systemctl is-active --quiet factory-api.service
fi
printf '\nFactory API snapshot restored: %s\nPrior enabled state: %s; prior active state: %s (failed/unknown restored as stopped).\nDatabases and factory-api account preserved.\n' "$snapshot" "$enabled" "$active"
