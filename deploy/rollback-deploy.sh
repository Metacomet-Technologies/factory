#!/usr/bin/env bash
# Remove the factory-deploy timer; the ledger and verified release directories are retained.
set -Eeuo pipefail
umask 0077
[[ $EUID -eq 0 ]] || { echo 'Run rollback-deploy.sh as root on factory-gpu.' >&2; exit 1; }
trap 'echo "Rollback stopped. Retry: gpu-ssh '\''sudo bash /home/agent/work/factory/deploy/rollback-deploy.sh'\''" >&2' ERR
[[ $# -eq 0 ]] || { echo 'Usage: rollback-deploy.sh' >&2; exit 1; }
[[ $(hostname) == factory-gpu ]]
for command in systemctl install mktemp cp date rm dirname; do command -v "$command" >/dev/null; done
for path in /var/backups/factory-deploy /etc/systemd/system/factory-deploy.service /etc/systemd/system/factory-deploy.timer; do
    while [[ "$path" != / ]]; do
        [[ ! -L "$path" ]]
        path=$(dirname "$path")
    done
done
[[ ! -e /var/backups/factory-deploy || -d /var/backups/factory-deploy ]]
for unit in factory-deploy.service factory-deploy.timer; do
    [[ ! -e "/etc/systemd/system/$unit" || -f "/etc/systemd/system/$unit" ]]
    [[ -z $(systemctl show "$unit" --property=DropInPaths --value) ]]
done
install -d -o root -g root -m 0700 /var/backups/factory-deploy
snapshot=$(mktemp -d "/var/backups/factory-deploy/rollback-$(date -u +%Y%m%dT%H%M%S).XXXXXX")
for unit in factory-deploy.service factory-deploy.timer; do
    if [[ -f "/etc/systemd/system/$unit" ]]; then cp -p "/etc/systemd/system/$unit" "$snapshot/$unit"; else : > "$snapshot/$unit.missing"; fi
    systemctl is-enabled "$unit" > "$snapshot/$unit.enabled" 2>/dev/null || true
done
if [[ $(systemctl show factory-deploy.timer --property=LoadState --value) != not-found ]]; then systemctl disable --now factory-deploy.timer; fi
# A deploy in flight finishes its component (TimeoutStartSec bounds it) before the unit file goes.
if [[ $(systemctl show factory-deploy.service --property=LoadState --value) != not-found ]]; then systemctl stop factory-deploy.service; fi
rm -f /etc/systemd/system/factory-deploy.service /etc/systemd/system/factory-deploy.timer
systemctl daemon-reload
printf 'Deploy timer removed; ledger and release directories under /home/agent/.local/state/factory-odd retained. Snapshot: %s\n' "$snapshot"
