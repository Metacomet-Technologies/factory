#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
root=$(dirname "$(dirname "$(realpath "$0")")")
snapshot=
rollback_hint() { printf '%s\n' "Rollback: factory-ssh 'sudo bash /home/agent/work/factory/deploy/rollback-usage.sh'" >&2; }
fail() { printf 'ERROR: %s\n' "$*" >&2; rollback_hint; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run install-usage.sh as root on factory-gpu.'
trap 'printf "ERROR: usage install failed at line %s; snapshot: %s\n" "$LINENO" "${snapshot:-none}" >&2; rollback_hint' ERR
[[ $# -eq 0 ]] || fail 'Usage: install-usage.sh'
[[ "$root" == /home/agent/work/factory ]] || fail 'Install only from the merged /home/agent/work/factory checkout.'

# Read-only preflight: no runtime installs, login, settings or runner changes.
for command in sudo systemctl stat getent install cp mktemp date sed cat dirname flock timeout realpath hostname cut chown chmod curl sleep; do
    command -v "$command" >/dev/null || fail "Missing command: $command"
done
[[ $(hostname) == factory-gpu ]] || fail 'Install only on factory-gpu.'
[[ $(getent passwd agent | cut -d: -f6) == /home/agent ]] || fail 'Require agent with home /home/agent.'
getent passwd factory-api >/dev/null
getent group factory-api >/dev/null
safe_path() {
    local path=$1
    while [[ "$path" != / ]]; do
        [[ ! -L "$path" ]] || fail "Refusing symlink: $path"
        path=$(dirname "$path")
    done
}
for file in scripts/usage/collect.ts scripts/usage/parsers.ts scripts/usage/.node-version scripts/usage/collect.lock deploy/install-usage.sh deploy/rollback-usage.sh deploy/factory-usage.service deploy/factory-usage.timer deploy/factory-usage-refresh.path; do
    safe_path "$root/$file"
    [[ -f "$root/$file" ]] || fail "Missing artifact: $file"
    sudo -u agent test -r "$root/$file"
done
for path in /var/backups/factory-usage /var/lib/factory-usage /var/lib/factory-usage/usage.json /var/lib/factory-usage-trigger /var/lib/factory-usage-trigger/request /etc/systemd/system; do
    safe_path "$path"
done
for directory in /var/backups/factory-usage /var/lib/factory-usage /var/lib/factory-usage-trigger; do
    [[ ! -e "$directory" || -d "$directory" ]] || fail "Not a directory: $directory"
done
[[ ! -e /var/lib/factory-usage/usage.json || -f /var/lib/factory-usage/usage.json ]] || fail 'usage.json must be a regular file.'
if [[ -f /var/lib/factory-usage/usage.json ]]; then
    [[ $(stat -c '%h' /var/lib/factory-usage/usage.json) == 1 ]] || fail 'Refusing hard-linked usage.json.'
fi
[[ ! -e /var/lib/factory-usage-trigger/request || -f /var/lib/factory-usage-trigger/request ]] || fail 'Trigger request must be a regular file.'
if [[ -f /var/lib/factory-usage-trigger/request ]]; then
    [[ $(stat -c '%h' /var/lib/factory-usage-trigger/request) == 1 ]] || fail 'Refusing hard-linked trigger request.'
fi
for unit in factory-usage.service factory-usage.timer factory-usage-refresh.path; do
    safe_path "/etc/systemd/system/$unit"
    [[ ! -e "/etc/systemd/system/$unit" || -f "/etc/systemd/system/$unit" ]] || fail "Unsafe unit: $unit"
    [[ -z $(systemctl show "$unit" --property=DropInPaths --value) ]] || fail "Review/remove $unit drop-ins before installing."
done
# A readable cwd is essential for the agent's Vite+ Node shim.
cd /home/agent/work
sudo -u agent test -x /home/agent/work
path=/usr/local/bin:/usr/bin:/bin
declare -A executables
for command in node amp claude codex; do
    # Keep script text out of sudo -i's login-shell command string.
    executable=$(sudo -iu agent bash -s -- "$command" <<'LOOKUP'
cd /home/agent/work && command -v "$1"
LOOKUP
    )
    [[ "$executable" =~ ^/[a-zA-Z0-9_./-]+$ && -x "$executable" ]] || fail "Require absolute executable path for $command."
    executables[$command]=$executable
    path="$(dirname "$executable"):$path"
    if [[ "$command" == node ]]; then node=$executable; fi
done
as_agent() { sudo -u agent env -i HOME=/home/agent USER=agent PATH="$path" "$@"; }
supported_node() { [[ $1 =~ ^v?24\.([0-9]+)\.([0-9]+)$ && ${BASH_REMATCH[1]} -ge 12 ]]; }
node_version=$(as_agent "$node" --version)
supported_node "$node_version" || fail "Use Node 24.x (>= 24.12.0); found $node_version"
for command in amp claude codex; do as_agent timeout 30s "${executables[$command]}" --version; done
# Collector dry-run emits only its sanitized snapshot, never raw CLI output.
preview_status=0
preview=$(as_agent timeout 300s "$node" "$root/scripts/usage/collect.ts" --dry-run) || preview_status=$?
printf '%s\n' "$preview"
[[ $preview_status -eq 0 ]] || fail 'Collector dry-run failed; no deployment changes made.'
check_snapshot() { as_agent "$node" --input-type=module -e '
const snapshot = JSON.parse(process.argv[1]);
for (const name of ["amp", "claude-code", "codex"]) {
  if (snapshot.tools?.find(tool => tool.tool === name)?.status !== "ok") {
    throw new Error(name + " must report ok before deployment");
  }
}' "$1"; }
check_snapshot "$preview"

# Snapshot units and state before any deployment mutation.
install -d -o root -g root -m 0700 /var/backups/factory-usage
snapshot=$(mktemp -d "/var/backups/factory-usage/$(date -u +%Y%m%dT%H%M%S).XXXXXX")
if [[ -d /var/lib/factory-usage-trigger ]]; then
    stat -c '%u:%g %a' /var/lib/factory-usage-trigger > "$snapshot/trigger-directory.mode"
else
    : > "$snapshot/trigger-directory.missing"
fi
for unit in factory-usage.service factory-usage.timer factory-usage-refresh.path; do
    if [[ -f "/etc/systemd/system/$unit" ]]; then cp -p "/etc/systemd/system/$unit" "$snapshot/$unit"; else : > "$snapshot/$unit.missing"; fi
    systemctl is-enabled "$unit" > "$snapshot/$unit.enabled" 2>/dev/null || true
    systemctl is-active "$unit" > "$snapshot/$unit.active" 2>/dev/null || true
done
printf 'Snapshot: %s\n' "$snapshot"
if [[ $(systemctl show factory-usage.timer --property=LoadState --value) != not-found ]]; then systemctl stop factory-usage.timer; fi
if [[ $(systemctl show factory-usage-refresh.path --property=LoadState --value) != not-found ]]; then systemctl stop factory-usage-refresh.path; fi
# Wait for any full collector run, using the committed shared lock inode.
exec 9<"$root/scripts/usage/collect.lock"
flock --exclusive --timeout 330 9
# Keep the directory inode: the already-running API has it mounted writable.
install -d -o factory-api -g factory-api -m 0700 /var/lib/factory-usage-trigger
install -d -o agent -g factory-api -m 2750 /var/lib/factory-usage
if [[ -f /var/lib/factory-usage/usage.json ]]; then
    chown agent:factory-api /var/lib/factory-usage/usage.json
    chmod 0640 /var/lib/factory-usage/usage.json
fi
sed -e "s|@NODE@|$node|g" -e "s|@PATH@|$path|g" "$root/deploy/factory-usage.service" > "$snapshot/new.service"
install -o root -g root -m 0644 "$snapshot/new.service" /etc/systemd/system/factory-usage.service
install -o root -g root -m 0644 "$root/deploy/factory-usage.timer" /etc/systemd/system/factory-usage.timer
install -o root -g root -m 0644 "$root/deploy/factory-usage-refresh.path" /etc/systemd/system/factory-usage-refresh.path
systemctl daemon-reload
flock --unlock 9
exec 9<&-
# Do not start a collector while holding its lock.
systemctl start factory-usage.service
as_agent test -r /var/lib/factory-usage/usage.json
sudo -u factory-api test -r /var/lib/factory-usage/usage.json
[[ $(stat -c '%U:%G %a' /var/lib/factory-usage) == 'agent:factory-api 2750' ]]
[[ $(stat -c '%U:%G %a' /var/lib/factory-usage/usage.json) == 'agent:factory-api 640' ]]
for ((attempt=0; attempt<30; attempt++)); do
    if sudo -u factory-api curl --max-time 2 -fsS http://127.0.0.1:8080/v1/agents >/dev/null 2>&1; then break; fi
    sleep 1
done
api=$(sudo -u factory-api curl --max-time 5 -fsS http://127.0.0.1:8080/v1/agents)
printf '%s\n' "$api"
check_snapshot "$api"
systemctl enable --now factory-usage.timer
systemctl is-active --quiet factory-usage.timer
systemctl is-enabled --quiet factory-usage.timer
sudo -u factory-api test -w /var/lib/factory-usage-trigger
sudo -u factory-api test -x /var/lib/factory-usage-trigger
[[ $(stat -c '%U:%G %a' /var/lib/factory-usage-trigger) == 'factory-api:factory-api 700' ]]
systemctl enable --now factory-usage-refresh.path
systemctl is-active --quiet factory-usage-refresh.path
systemctl is-enabled --quiet factory-usage-refresh.path
[[ $(systemctl show factory-usage-refresh.path --property=Triggers --value) == factory-usage.service ]]
printf '%s\n' 'Usage timer and refresh path enabled. API, databases, runners and login/settings unchanged.'
