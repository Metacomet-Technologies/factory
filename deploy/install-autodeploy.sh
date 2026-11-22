#!/usr/bin/env bash
# Install factory-autodeploy.timer on factory-gpu (Devon, once):
#   gpu-ssh 'sudo bash /home/agent/work/factory/deploy/install-autodeploy.sh'
# The timer runs deploy/autodeploy.sh from the main checkout as agent, so later
# changes to the script ship with main; only unit changes need a rerun.
set -Eeuo pipefail
umask 0022
units=(factory-autodeploy.service factory-autodeploy.timer)
root=$(dirname "$(dirname "$(realpath "$0")")")
snapshot=
rollback_hint() { printf '%s\n' "Rollback: gpu-ssh 'sudo bash /home/agent/work/factory/deploy/rollback-autodeploy.sh'" >&2; }
fail() { printf 'ERROR: %s\n' "$*" >&2; rollback_hint; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run install-autodeploy.sh as root on factory-gpu.'
trap 'printf "ERROR: autodeploy install failed at line %s; snapshot: %s\n" "$LINENO" "${snapshot:-none}" >&2; rollback_hint' ERR
[[ $# -eq 0 ]] || fail 'Usage: install-autodeploy.sh'

# Read-only preflight.
[[ $(hostname -s) == factory-gpu ]] || fail 'Install only on factory-gpu.'
[[ $root == /home/agent/work/factory ]] || fail 'Install only from the /home/agent/work/factory checkout.'
[[ $(getent passwd agent | cut -d: -f6) == /home/agent ]] || fail 'Require agent with home /home/agent.'
[[ -x /usr/local/sbin/factory-deploy ]] || fail 'Install factory-deploy first (deploy/sudoers/README.md).'
sudo -l -U agent | grep -q '/usr/local/sbin/factory-deploy' || fail 'agent lacks the factory-deploy sudo rule.'
for file in deploy/autodeploy.sh "${units[@]/#/deploy/}"; do
    [[ -f $root/$file && ! -L $root/$file ]] || fail "Missing or symlinked: $file"
done
sudo -u agent -H gh auth status >/dev/null 2>&1 || fail 'gh is not signed in for agent.'
sudo -u agent -H git -C "$root" ls-remote --exit-code origin refs/heads/main >/dev/null || fail 'agent cannot reach origin.'
for unit in "${units[@]}"; do
    [[ -z $(systemctl show "$unit" --property=DropInPaths --value) ]] || fail "Review/remove $unit drop-ins first."
done

# Snapshot the current units and their state.
install -d -o root -g root -m 0700 /var/backups/factory-autodeploy
snapshot=$(mktemp -d "/var/backups/factory-autodeploy/$(date -u +%Y%m%dT%H%M%S).XXXXXX")
for unit in "${units[@]}"; do
    if [[ -f /etc/systemd/system/$unit ]]; then cp -p "/etc/systemd/system/$unit" "$snapshot/$unit"; else : > "$snapshot/$unit.missing"; fi
    systemctl is-enabled "$unit" > "$snapshot/$unit.enabled" 2>/dev/null || true
done
printf 'Snapshot: %s\n' "$snapshot"

for unit in "${units[@]}"; do
    install -o root -g root -m 0644 "$root/deploy/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable --now factory-autodeploy.timer
systemctl is-active --quiet factory-autodeploy.timer
systemctl is-enabled --quiet factory-autodeploy.timer
printf '%s\n' 'factory-autodeploy.timer enabled; first check in 1 minute.' \
    'Watch: journalctl -u factory-autodeploy -f   Status: cat /var/lib/factory-autodeploy/status.json'
