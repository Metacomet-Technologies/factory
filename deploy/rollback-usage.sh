#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
[[ $EUID -eq 0 ]] || { echo 'Run rollback-usage.sh as root on factory-gpu.' >&2; exit 1; }
trap 'echo "Rollback stopped. Retry: gpu-ssh '\''sudo bash /home/agent/work/factory/deploy/rollback-usage.sh'\''" >&2' ERR
remove_key=0
if [[ $# -eq 1 && $1 == --remove-cursor-admin-key ]]; then remove_key=1
else [[ $# -eq 0 ]] || { echo 'Usage: rollback-usage.sh [--remove-cursor-admin-key]' >&2; exit 1; }
fi
[[ $(hostname) == factory-gpu ]]
for command in systemctl install mktemp cp date rm dirname; do command -v "$command" >/dev/null; done
for path in /var/backups/factory-usage /etc/systemd/system/factory-usage.service /etc/systemd/system/factory-usage.timer /etc/systemd/system/factory-usage-refresh.path; do
    while [[ "$path" != / ]]; do
        [[ ! -L "$path" ]]
        path=$(dirname "$path")
    done
done
[[ ! -e /var/backups/factory-usage || -d /var/backups/factory-usage ]]
for unit in factory-usage.service factory-usage.timer factory-usage-refresh.path; do
    [[ ! -e "/etc/systemd/system/$unit" || -f "/etc/systemd/system/$unit" ]]
    [[ -z $(systemctl show "$unit" --property=DropInPaths --value) ]]
done
install -d -o root -g root -m 0700 /var/backups/factory-usage
snapshot=$(mktemp -d "/var/backups/factory-usage/rollback-$(date -u +%Y%m%dT%H%M%S).XXXXXX")
for unit in factory-usage.service factory-usage.timer factory-usage-refresh.path; do
    if [[ -f "/etc/systemd/system/$unit" ]]; then cp -p "/etc/systemd/system/$unit" "$snapshot/$unit"; else : > "$snapshot/$unit.missing"; fi
    systemctl is-enabled "$unit" > "$snapshot/$unit.enabled" 2>/dev/null || true
    systemctl is-active "$unit" > "$snapshot/$unit.active" 2>/dev/null || true
done
if [[ $(systemctl show factory-usage-refresh.path --property=LoadState --value) != not-found ]]; then systemctl disable --now factory-usage-refresh.path; fi
if [[ $(systemctl show factory-usage.timer --property=LoadState --value) != not-found ]]; then systemctl disable --now factory-usage.timer; fi
if [[ $(systemctl show factory-usage.service --property=LoadState --value) != not-found ]]; then systemctl disable --now factory-usage.service; fi
rm -f /etc/systemd/system/factory-usage.service /etc/systemd/system/factory-usage.timer /etc/systemd/system/factory-usage-refresh.path
systemctl daemon-reload
# The Cursor admin key stays unless removal is requested; it is never backed up.
if [[ $remove_key -eq 1 ]]; then
    [[ ! -L /etc/factory-usage && ! -L /etc/factory-usage/cursor-admin-key ]]
    rm -f /etc/factory-usage/cursor-admin-key
    echo 'Cursor admin key removed.'
fi
# Retain the trigger directory too: it may be mounted by the running API.
printf 'Usage units removed; usage.json, trigger directory and snapshots retained. Snapshot: %s\n' "$snapshot"
