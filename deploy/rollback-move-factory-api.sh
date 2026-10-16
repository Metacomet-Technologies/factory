#!/usr/bin/env bash
# Run GPU first, then console. No DB is replaced or deleted on either node.
set -Eeuo pipefail
umask 0077
dry=0
if [[ ${1:-} == --dry-run ]]; then dry=1; shift; fi
[[ $# == 1 && ( $1 == gpu || $1 == console ) ]] || { echo 'Usage: rollback-move-factory-api.sh [--dry-run] gpu|console' >&2; exit 1; }
node=$1
snapshot=/var/backups/factory-api-move/$node
hint() { echo "Retry: sudo bash /home/agent/work/factory/deploy/rollback-move-factory-api.sh $node" >&2; }
fail() { echo "ERROR: $*" >&2; hint; exit 1; }
trap 'echo "Rollback failed at line $LINENO; DBs retained. Keep clients off until recovery completes." >&2; hint' ERR
if (( dry )); then
    echo "Dry-run $node: verify saved backup config; preserve current config; stop backups; restore saved backup config; no DB copies or deletions."
    if [[ $node == gpu ]]; then
        echo 'Stop/disable GPU API; resume meter-only backup timer. Then run console rollback.'
    else
        echo 'After GPU is stopped: enable/start console API and backup timer; verify health/fleet/usage/pricing as factory-api.'
    fi
else
    [[ $EUID == 0 && $(hostname -s) == factory-$node ]] || fail "Run as root on factory-$node only."
    for command in systemctl sudo curl jq cp install flock; do command -v "$command" >/dev/null; done
    [[ -f "$snapshot/nodes.conf" && ! -L "$snapshot" && ! -L "$snapshot/nodes.conf" ]] || fail 'Missing/unsafe saved backup config; do not guess the previous layout.'
    [[ ! -L /etc/factory-backup/nodes.conf && ! -L /var/backups/factory-db/.backup.lock ]] || fail 'Unsafe backup configuration/lock.'
    if [[ $node == console ]]; then
        for name in requests pricing; do
            [[ -f /var/lib/factory-api/$name.db ]] || fail "Original $name.db missing."
        done
    fi
    exec 8>"$snapshot/lock"
    flock -n 8 || fail 'Move or rollback already running.'
    if [[ ! -f "$snapshot/pre-rollback-nodes.conf" ]]; then
        cp -p /etc/factory-backup/nodes.conf "$snapshot/pre-rollback-nodes.conf"
    fi
    systemctl disable --now factory-backup.timer
    systemctl stop factory-backup.service
    exec 9>>/var/backups/factory-db/.backup.lock
    flock -n 9 || fail 'Backup/deployment already running.'
    if [[ $node == gpu ]]; then
        if [[ $(systemctl show factory-api.service --property=LoadState --value) != not-found ]]; then
            systemctl disable --now factory-api.service
        fi
    fi
    install -o root -g root -m 0644 "$snapshot/nodes.conf" /etc/factory-backup/nodes.conf
    touch "$snapshot/rolled-back"
    exec 9>&-
    if [[ $node == console ]]; then
        systemctl enable --now factory-api.service
        deadline=$((SECONDS + 45))
        until sudo -u factory-api curl -fs --max-time 2 -o /dev/null http://127.0.0.1:8080/v1/health; do
            (( SECONDS < deadline )) || break
            sleep 1
        done
        sudo -u factory-api curl -fsS --max-time 2 http://127.0.0.1:8080/v1/health | jq -e '.status == "ok"'
        for endpoint in fleet llm/usage pricing; do
            sudo -u factory-api curl -fsS --max-time 30 "http://127.0.0.1:8080/v1/$endpoint" | jq -e .
        done
    fi
    systemctl enable --now factory-backup.timer
fi
cat <<'COMMANDS'
Only after BOTH rollback steps succeed, run from Mac (Serve/kiosk commands are printed, never run here):
console-ssh 'sudo tailscale serve --bg --https=443 http://127.0.0.1:8080'
gpu-ssh 'sudo tailscale serve --bg --https=443 off'
console-ssh "sudo -u console sed -i '/^Exec=/s|--app=https://factory-gpu.bearded-pompano.ts.net|--app=http://localhost:8080|' /home/console/.config/autostart/console-kiosk.desktop"
Relaunch Chrome in the console desktop session. GPU DBs and console originals remain in place; post-cutover GPU writes are not merged back.
COMMANDS
