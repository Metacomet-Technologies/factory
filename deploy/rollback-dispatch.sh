#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
[[ $EUID -eq 0 ]] || { echo 'Run rollback-dispatch.sh as root on factory-gpu.' >&2; exit 1; }
trap 'echo "Rollback stopped. Retry: gpu-ssh '\''sudo bash /home/agent/work/factory/deploy/rollback-dispatch.sh'\''" >&2' ERR
[[ $# -eq 0 ]] || { echo 'Usage: rollback-dispatch.sh' >&2; exit 1; }
[[ $(hostname) == factory-gpu ]] || { echo 'Rollback only on factory-gpu.' >&2; exit 1; }
for command in systemctl install mktemp cp date rm; do command -v "$command" >/dev/null; done
for unit in factory-dispatch.service factory-dispatch.timer; do
    [[ ! -L "/etc/systemd/system/$unit" ]]
done
install -d -o root -g root -m 0700 /var/backups/factory-dispatch
snapshot=$(mktemp -d "/var/backups/factory-dispatch/rollback-$(date -u +%Y%m%dT%H%M%S).XXXXXX")
for unit in factory-dispatch.service factory-dispatch.timer; do
    if [[ -f "/etc/systemd/system/$unit" ]]; then cp -p "/etc/systemd/system/$unit" "$snapshot/$unit"; fi
done
if [[ $(systemctl show factory-dispatch.timer --property=LoadState --value) != not-found ]]; then
    systemctl disable --now factory-dispatch.timer
fi
if [[ $(systemctl show factory-dispatch.service --property=LoadState --value) != not-found ]]; then
    systemctl stop factory-dispatch.service
fi
rm -f /etc/systemd/system/factory-dispatch.service /etc/systemd/system/factory-dispatch.timer
systemctl daemon-reload
printf 'Dispatcher removed; key, Linear claims, threads and runners retained. Snapshot: %s\n' "$snapshot"
