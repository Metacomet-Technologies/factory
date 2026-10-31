#!/usr/bin/env bash
# ODD phase 5 (MET-280): install the factory-deploy timer that runs scripts/odd/deploy.ts as
# agent. Devon runs this once from the Mac; it is deliberately not in the sudoers allowlist.
# --tools-cutover (MET-346) repoints the installed deploy, dispatch and usage units from this
# checkout to the deployer-promoted /home/agent/factory-tools/current link, changing only their
# ExecStart script path; --revert-tools-cutover SNAPSHOT restores those unit files.
set -Eeuo pipefail
umask 0077
root=$(dirname "$(dirname "$(realpath "$0")")")
snapshot=
mode=${1:-}
rollback_hint() {
    if [[ $mode == --tools-cutover && -n $snapshot ]]; then printf '%s\n' "Rollback: gpu-ssh 'sudo bash /home/agent/work/factory/deploy/install-deploy.sh --revert-tools-cutover $snapshot'" >&2
    else printf '%s\n' "Rollback: gpu-ssh 'sudo bash /home/agent/work/factory/deploy/rollback-deploy.sh'" >&2
    fi
}
fail() { printf 'ERROR: %s\n' "$*" >&2; rollback_hint; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run install-deploy.sh as root on factory-gpu.'
trap 'printf "ERROR: deploy-timer install failed at line %s; snapshot: %s\n" "$LINENO" "${snapshot:-none}" >&2; rollback_hint' ERR
[[ $# -eq 0 || ( $# -eq 1 && $1 =~ ^--(install-only|tools-cutover)$ ) || ( $# -eq 2 && $1 == --revert-tools-cutover ) ]] ||
    fail 'Usage: install-deploy.sh [--install-only | --tools-cutover | --revert-tools-cutover SNAPSHOT]'
[[ "$root" == /home/agent/work/factory ]] || fail 'Install only from the merged /home/agent/work/factory checkout.'

# Read-only preflight.
for command in sudo systemctl getent install cp mktemp date sed dirname flock realpath hostname cut git curl tar python3 grep timeout cat; do
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
for file in .node-version scripts/odd/deploy.ts scripts/odd/lifecycle.ts scripts/release/release.py deploy/components.json deploy/factory-deploy.service deploy/factory-deploy.timer deploy/install-deploy.sh deploy/rollback-deploy.sh \
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
# MET-375: only the root-owned staged tree; an entry naming the agent checkout is effective root for agent.
[[ "$allowed" != *"/home/agent/"* ]] || fail 'Allowlist still names agent-writable scripts; restage (deploy/sudoers/README.md).'
for script in install-meter.sh rollback-meter-v1.sh install-factory-api.sh rollback-factory-api.sh install-kiosk.sh; do
    [[ "$allowed" == *"/usr/bin/bash /usr/local/lib/factory-deploy/deploy/$script *"* ]] || fail "Allowlist lacks the staged deploy/$script."
done
sudo -u agent test -r /etc/factory-dispatch/linear-api-key || fail 'agent cannot read /etc/factory-dispatch/linear-api-key.'
# Starting the job needs a reviewed baseline; install-only never creates one.
ledger=/home/agent/.local/state/factory-odd/deploy.json
[[ ${1:-} == --install-only ]] || sudo -u agent test -s "$ledger" ||
    fail "No deploy ledger at $ledger; nothing changed. Use --install-only, investigate, establish a reviewed baseline with deploy.ts --bootstrap TAG (docs/odd/deployer-recovery.md), then rerun."
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
# Pin the Vite+ shim as the units do (MET-411); the global default may be unset or newer.
pin=$(<"$root/.node-version")
as_agent() { sudo -u agent env -i HOME=/home/agent USER=agent PATH="$path" VP_NODE_VERSION="$pin" "$@"; }
node_version=$(as_agent "$node" --version)
[[ $node_version =~ ^v?24\.([0-9]+)\.([0-9]+)$ && ${BASH_REMATCH[1]} -ge 12 ]] || fail "Use Node 24.x (>= 24.12.0); found $node_version"
as_agent gh auth status >/dev/null 2>&1 || fail 'agent is not logged in to GitHub (gh auth status).'
as_agent git -C "$root" fetch --quiet --tags origin || fail 'agent cannot fetch tags from origin.'
status=$(as_agent git -C "$root" status --porcelain) || fail 'Cannot read deployment tools checkout status.'
[[ -z "$status" ]] || fail 'Require a clean deployment tools checkout.'

# The units execute the deployer-promoted runtime; the allowlisted installers stay in $root.
tools=/home/agent/factory-tools/current
services=(factory-deploy.service factory-dispatch.service factory-usage.service)
triggers=(factory-deploy.timer factory-dispatch.timer factory-usage.timer factory-usage-refresh.path)
check_tools() {
    local resolved check
    resolved=$(as_agent realpath -e "$tools") || fail "No tools runtime at $tools; nothing changed. Wait for factory-deploy to log tools-promoted (docs/odd/deployer-recovery.md)."
    [[ $resolved =~ ^/home/agent/factory-tools/v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "$tools resolves to $resolved, not a promoted release."
    for check in 'scripts/odd/deploy.ts --self-check' 'scripts/dispatch/dispatch.ts check' 'scripts/usage/collect.ts --self-check'; do
        as_agent timeout 60 "$node" --permission --allow-fs-read='*' "$tools/${check% *}" "${check#* }" | grep -qF "\"root\":\"$resolved\"" ||
            fail "Tools self-check failed in $resolved: $check"
    done
    printf 'Tools: %s %s\n' "$resolved" "$(cat "$resolved/.factory-tools.json")"
    printf 'Installer: %s %s\n' "$root" "$(as_agent git -C "$root" rev-parse HEAD)"
}
stop_triggers() { local unit; for unit in "${triggers[@]}"; do systemctl stop "$unit"; done; }
# Starts only the triggers the snapshot recorded active; enablement is never changed.
start_triggers() { local unit; for unit in "${triggers[@]}"; do if [[ $(cat "$1/$unit.active") == active ]]; then systemctl start "$unit"; fi; done; }
require_idle() {
    local unit
    for unit in "${services[@]}"; do
        case $(systemctl show "$unit" --property=ActiveState --value) in
            inactive|failed) ;;
            *) start_triggers "$1"; fail "Wait for $unit to finish before replacing its unit; triggers restored." ;;
        esac
    done
}
if [[ $mode == --tools-cutover ]]; then
    check_tools
    declare -A entry=([factory-deploy.service]=odd/deploy.ts [factory-dispatch.service]=dispatch/dispatch.ts [factory-usage.service]=usage/collect.ts)
    for unit in "${services[@]}"; do
        file=/etc/systemd/system/$unit
        safe_path "$file"
        [[ -f $file ]] || fail "Install $unit before the tools cutover."
        if [[ $(grep -c '^ExecStart=' "$file") != 1 ]] || ! grep -Eq "^ExecStart=.* /home/agent/work/factory/scripts/${entry[$unit]}( |\$)" "$file"; then
            fail "$unit does not execute /home/agent/work/factory/scripts/${entry[$unit]}; inspect it."
        fi
        for dropin in $(systemctl show "$unit" --property=DropInPaths --value); do
            ! grep -q '^ExecStart' "$dropin" || fail "Drop-in $dropin overrides ExecStart; review it first."
        done
    done
    for unit in "${triggers[@]}"; do safe_path "/etc/systemd/system/$unit"; done
    install -d -o root -g root -m 0700 /var/backups/factory-deploy
    snapshot=$(mktemp -d "/var/backups/factory-deploy/tools-cutover-$(date -u +%Y%m%dT%H%M%S).XXXXXX")
    for unit in "${services[@]}" "${triggers[@]}"; do
        if [[ -f "/etc/systemd/system/$unit" ]]; then cp -p "/etc/systemd/system/$unit" "$snapshot/$unit"; fi
        systemctl is-enabled "$unit" > "$snapshot/$unit.enabled" 2>/dev/null || true
        systemctl is-active "$unit" > "$snapshot/$unit.active" 2>/dev/null || true
    done
    printf 'Snapshot: %s\n' "$snapshot"
    require_idle "$snapshot"
    stop_triggers
    require_idle "$snapshot"
    # Only the script path changes; node, PATH, environment, limits and drop-ins are preserved.
    for unit in "${services[@]}"; do
        sed -E 's#^(ExecStart=.* )/home/agent/work/factory/scripts/#\1/home/agent/factory-tools/current/scripts/#' "$snapshot/$unit" > "$snapshot/new-$unit"
        grep -q '^ExecStart=.* /home/agent/factory-tools/current/scripts/' "$snapshot/new-$unit"
        install -o root -g root -m 0644 "$snapshot/new-$unit" "/etc/systemd/system/$unit"
    done
    systemctl daemon-reload
    start_triggers "$snapshot"
    printf 'Units now execute %s; trigger states restored; ledger unchanged.\n' "$tools"
    exit 0
fi
if [[ $mode == --revert-tools-cutover ]]; then
    snapshot=$(realpath -e "$2") || fail "No snapshot $2."
    [[ $snapshot == /var/backups/factory-deploy/* && -d $snapshot ]] || fail "Not a deploy snapshot: $snapshot"
    for unit in "${services[@]}" "${triggers[@]}"; do [[ -f $snapshot/$unit.active ]] || fail "Snapshot lacks $unit state."; done
    for unit in "${services[@]}"; do [[ -f $snapshot/$unit ]] || fail "Snapshot lacks $unit."; done
    stop_triggers
    require_idle "$snapshot"
    for unit in "${services[@]}"; do install -o root -g root -m 0644 "$snapshot/$unit" "/etc/systemd/system/$unit"; done
    systemctl daemon-reload
    start_triggers "$snapshot"
    printf 'Restored deploy, dispatch and usage units from %s; trigger states restored; ledger and tools unchanged.\n' "$snapshot"
    exit 0
fi
check_tools

# Snapshot units before any deployment mutation.
install -d -o root -g root -m 0700 /var/backups/factory-deploy
snapshot=$(mktemp -d "/var/backups/factory-deploy/$(date -u +%Y%m%dT%H%M%S).XXXXXX")
for unit in factory-deploy.service factory-deploy.timer; do
    if [[ -f "/etc/systemd/system/$unit" ]]; then cp -p "/etc/systemd/system/$unit" "$snapshot/$unit"; else : > "$snapshot/$unit.missing"; fi
    systemctl is-enabled "$unit" > "$snapshot/$unit.enabled" 2>/dev/null || true
done
printf 'Snapshot: %s\n' "$snapshot"
if [[ $(systemctl show factory-deploy.timer --property=LoadState --value) != not-found ]]; then
    if [[ ${1:-} == --install-only ]]; then systemctl disable --now factory-deploy.timer
    else systemctl stop factory-deploy.timer
    fi
fi
case $(systemctl show factory-deploy.service --property=ActiveState --value) in
    inactive|failed) ;;
    *) fail 'Wait for the running deploy service to finish before replacing its units.' ;;
esac
sed -e "s|@NODE@|$node|g" -e "s|@PATH@|$path|g" "$root/deploy/factory-deploy.service" > "$snapshot/new.service"
install -o root -g root -m 0644 "$snapshot/new.service" /etc/systemd/system/factory-deploy.service
install -o root -g root -m 0644 "$root/deploy/factory-deploy.timer" /etc/systemd/system/factory-deploy.timer
systemctl daemon-reload
if [[ ${1:-} == --install-only ]]; then
    systemctl disable --now factory-deploy.timer
    [[ $(systemctl show factory-deploy.timer --property=UnitFileState --value) == disabled ]] || fail 'Deploy timer is not persistently disabled.'
    [[ $(systemctl show factory-deploy.timer --property=ActiveState --value) == inactive ]] || fail 'Deploy timer is not inactive.'
    printf '%s\n' 'Deploy units installed; timer disabled and inactive, ledger unchanged (never created). Reconcile or bootstrap explicitly before starting factory-deploy.service and enabling the timer.'
    exit 0
fi
# Each run deploys releases pending above the existing ledger, bounded by the unit's TimeoutStartSec;
# deploy.ts fails without deploying when the ledger is missing or invalid.
systemctl start factory-deploy.service
systemctl enable --now factory-deploy.timer
systemctl is-active --quiet factory-deploy.timer
systemctl is-enabled --quiet factory-deploy.timer
printf '%s\n' 'Deploy timer enabled. Ledger: /home/agent/.local/state/factory-odd/deploy.json; logs: journalctl -u factory-deploy.'
