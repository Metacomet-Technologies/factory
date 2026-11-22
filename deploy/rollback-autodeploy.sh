#!/usr/bin/env bash
# Stop and remove factory-autodeploy; deploys go back to manual factory-deploy.
#   gpu-ssh 'sudo bash /home/agent/work/factory/deploy/rollback-autodeploy.sh'
# Keeps /var/lib/factory-autodeploy (status for the alerts) and the snapshots.
set -Eeuo pipefail
umask 0077
units=(factory-autodeploy.timer factory-autodeploy.service)
[[ $EUID -eq 0 ]] || { echo 'Run rollback-autodeploy.sh as root on factory-gpu.' >&2; exit 1; }
trap 'echo "Rollback stopped at line $LINENO. Retry: gpu-ssh '\''sudo bash /home/agent/work/factory/deploy/rollback-autodeploy.sh'\''" >&2' ERR
[[ $# -eq 0 ]] || { echo 'Usage: rollback-autodeploy.sh' >&2; exit 1; }
[[ $(hostname -s) == factory-gpu ]]
for unit in "${units[@]}"; do
    [[ ! -L /etc/systemd/system/$unit ]]
done

install -d -o root -g root -m 0700 /var/backups/factory-autodeploy
snapshot=$(mktemp -d "/var/backups/factory-autodeploy/rollback-$(date -u +%Y%m%dT%H%M%S).XXXXXX")
for unit in "${units[@]}"; do
    if [[ -f /etc/systemd/system/$unit ]]; then cp -p "/etc/systemd/system/$unit" "$snapshot/$unit"; fi
done
for unit in "${units[@]}"; do
    if [[ $(systemctl show "$unit" --property=LoadState --value) != not-found ]]; then systemctl disable --now "$unit"; fi
done
rm -f /etc/systemd/system/factory-autodeploy.timer /etc/systemd/system/factory-autodeploy.service
systemctl daemon-reload
if systemctl is-active --quiet factory-autodeploy.timer; then echo "factory-autodeploy.timer is still active" >&2; exit 1; fi
printf 'Auto-deploy removed; deploy with sudo factory-deploy. Snapshot: %s\n' "$snapshot"
