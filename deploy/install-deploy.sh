#!/usr/bin/env bash
# ODD phase 5 (MET-280): install the factory-deploy timer that runs scripts/odd/deploy.ts as
# agent. Devon runs this once from the Mac; it is deliberately not in the sudoers allowlist.
set -Eeuo pipefail
umask 0077
root=$(dirname "$(dirname "$(realpath "$0")")")
snapshot=
rollback_hint() { printf '%s\n' "Rollback: gpu-ssh 'sudo bash /home/agent/work/factory/deploy/rollback-deploy.sh'" >&2; }
fail() { printf 'ERROR: %s\n' "$*" >&2; rollback_hint; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run install-deploy.sh as root on factory-gpu.'
trap 'printf "ERROR: deploy-timer install failed at line %s; snapshot: %s\n" "$LINENO" "${snapshot:-none}" >&2; rollback_hint' ERR
[[ $# -eq 0 ]] || fail 'Usage: install-deploy.sh'
[[ "$root" == /home/agent/work/factory ]] || fail 'Install only from the merged /home/agent/work/factory checkout.'

# Read-only preflight.
for command in sudo systemctl getent install cp mktemp date sed dirname flock realpath hostname cut git curl tar python3; do
    command -v "$command" >/dev/null || fail "Missing command: $command"
done
[[ $(hostname) == factory-gpu ]] || fail 'Install only on factory-gpu.'
[[ $(getent passwd agent | cut -d: -f6) == /home/agent ]] || fail 'Require agent with home /home/agent.'
safe_path() {
    local path=$1
    while [[ "$path" != / ]]; do
        [[ ! -L "$path" ]] || fail "Refusing symlink: $path"
        path=$(dirname "$path")
    done
}
for file in scripts/odd/deploy.ts scripts/odd/lifecycle.ts scripts/release/release.py deploy/components.json deploy/factory-deploy.service deploy/factory-deploy.timer deploy/install-deploy.sh deploy/rollback-deploy.sh \
    deploy/install-meter.sh deploy/rollback-meter-v1.sh deploy/install-factory-api.sh deploy/rollback-factory-api.sh deploy/install-kiosk.sh deploy/rollback-kiosk.sh deploy/install-usage.sh deploy/rollback-usage.sh; do
    safe_path "$root/$file"
    [[ -f "$root/$file" ]] || fail "Missing artifact: $file"
    sudo -u agent test -r "$root/$file"
done
for unit in factory-deploy.service factory-deploy.timer; do
    safe_path "/etc/systemd/system/$unit"
    [[ ! -e "/etc/systemd/system/$unit" || -f "/etc/systemd/system/$unit" ]] || fail "Unsafe unit: $unit"
    [[ -z $(systemctl show "$unit" --property=DropInPaths --value) ]] || fail "Review/remove $unit drop-ins before installing."
done
safe_path /var/backups/factory-deploy
[[ ! -e /var/backups/factory-deploy || -d /var/backups/factory-deploy ]] || fail 'Not a directory: /var/backups/factory-deploy'
# The job deploys only through the allowlist and reads the dispatcher's Linear key.
allowed=$(sudo -u agent sudo -n -l 2>/dev/null) || fail 'agent has no passwordless sudo allowlist.'
for script in install-meter.sh rollback-meter-v1.sh install-factory-api.sh rollback-factory-api.sh install-kiosk.sh rollback-kiosk.sh install-usage.sh rollback-usage.sh; do
    [[ "$allowed" == *"/usr/bin/bash /home/agent/work/factory/deploy/$script *"* ]] || fail "Allowlist lacks deploy/$script."
done
sudo -u agent test -r /etc/factory-dispatch/linear-api-key || fail 'agent cannot read /etc/factory-dispatch/linear-api-key.'
cd /home/agent/work
sudo -u agent test -x /home/agent/work
path=/usr/local/bin:/usr/bin:/bin
for command in node gh; do
    executable=$(sudo -iu agent bash -s -- "$command" <<'LOOKUP'
cd /home/agent/work && command -v "$1"
LOOKUP
    )
    [[ "$executable" =~ ^/[a-zA-Z0-9_./-]+$ && -x "$executable" ]] || fail "Require absolute executable path for $command."
    path="$(dirname "$executable"):$path"
    if [[ "$command" == node ]]; then node=$executable; fi
done
as_agent() { sudo -u agent env -i HOME=/home/agent USER=agent PATH="$path" "$@"; }
node_version=$(as_agent "$node" --version)
[[ $node_version =~ ^v?24\.([0-9]+)\.([0-9]+)$ && ${BASH_REMATCH[1]} -ge 12 ]] || fail "Use Node 24.x (>= 24.12.0); found $node_version"
as_agent gh auth status >/dev/null 2>&1 || fail 'agent is not logged in to GitHub (gh auth status).'
as_agent git -C "$root" fetch --quiet --tags origin || fail 'agent cannot fetch tags from origin.'

# Snapshot units before any deployment mutation.
install -d -o root -g root -m 0700 /var/backups/factory-deploy
snapshot=$(mktemp -d "/var/backups/factory-deploy/$(date -u +%Y%m%dT%H%M%S).XXXXXX")
for unit in factory-deploy.service factory-deploy.timer; do
    if [[ -f "/etc/systemd/system/$unit" ]]; then cp -p "/etc/systemd/system/$unit" "$snapshot/$unit"; else : > "$snapshot/$unit.missing"; fi
    systemctl is-enabled "$unit" > "$snapshot/$unit.enabled" 2>/dev/null || true
done
printf 'Snapshot: %s\n' "$snapshot"
if [[ $(systemctl show factory-deploy.timer --property=LoadState --value) != not-found ]]; then systemctl stop factory-deploy.timer; fi
sed -e "s|@NODE@|$node|g" -e "s|@PATH@|$path|g" "$root/deploy/factory-deploy.service" > "$snapshot/new.service"
install -o root -g root -m 0644 "$snapshot/new.service" /etc/systemd/system/factory-deploy.service
install -o root -g root -m 0644 "$root/deploy/factory-deploy.timer" /etc/systemd/system/factory-deploy.timer
systemctl daemon-reload
# First run records the latest release in the ledger without deploying (deploy.ts bootstrap);
# later runs deploy pending releases, bounded by the unit's TimeoutStartSec.
systemctl start factory-deploy.service
systemctl enable --now factory-deploy.timer
systemctl is-active --quiet factory-deploy.timer
systemctl is-enabled --quiet factory-deploy.timer
printf '%s\n' 'Deploy timer enabled. Ledger: /home/agent/.local/state/factory-odd/deploy.json; logs: journalctl -u factory-deploy.'
