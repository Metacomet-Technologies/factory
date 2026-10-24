#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
root=$(dirname "$(dirname "$(realpath "$0")")")
key=/etc/factory-dispatch/linear-api-key
# The one accepted service drop-in (MET-215): runner caps, tuned without reinstalling.
caps_dropin=/etc/systemd/system/factory-dispatch.service.d/cap.conf
snapshot=
rollback_hint() { printf 'Rollback: gpu-ssh '\''sudo bash /home/agent/work/factory/deploy/rollback-dispatch.sh'\'' (leaves %s unchanged)\n' "$caps_dropin" >&2; }
fail() { printf 'ERROR: %s\n' "$*" >&2; rollback_hint; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run this installer as root on factory-gpu.'
trap 'printf "ERROR: dispatcher install failed at line %s; snapshot: %s\n" "$LINENO" "${snapshot:-none}" >&2; rollback_hint' ERR
[[ $# -eq 0 ]] || fail 'Usage: install-dispatch.sh < console-runner-list.json (fresh amp runner list --json from console as agent).'
[[ "$root" == /home/agent/work/factory ]] || fail 'Install only from the merged /home/agent/work/factory checkout.'

# Read-only preflight. Never create a key, install a runtime, or touch a runner.
for command in sudo systemctl stat getent install cp mktemp date sed cat dirname flock; do
    command -v "$command" >/dev/null || fail "Missing command: $command"
done
[[ $(hostname) == factory-gpu ]] || fail 'Install the dispatcher only on factory-gpu.'
getent passwd agent >/dev/null
getent group agent >/dev/null
if [[ ! -f "$key" || -L "$key" ]]; then
    cat >&2 <<'INSTRUCTIONS'
From Mac, open gpu-ssh. In that shell, substitute the existing 1Password
item/field below; do not create or print a credential. Resolve a symlink manually.
set -euo pipefail
set +x
umask 077
temporary=$(mktemp)
trap 'rm -f "$temporary"' EXIT
opin read 'op://Factory/<existing Linear item>/<key field>' > "$temporary"
test -s "$temporary"
sudo install -d -o root -g agent -m 0750 /etc/factory-dispatch
sudo install -o root -g agent -m 0640 "$temporary" /etc/factory-dispatch/linear-api-key
rm -f "$temporary"
trap - EXIT
exit
INSTRUCTIONS
    fail 'Require an existing regular /etc/factory-dispatch/linear-api-key before installation.'
fi
[[ $(stat -c '%U:%G %a' "$key") == 'root:agent 640' ]] || fail 'Require root:agent 0640: sudo chown root:agent /etc/factory-dispatch/linear-api-key; sudo chmod 0640 /etc/factory-dispatch/linear-api-key.'
sudo -u agent test -r "$key"
[[ -s "$key" ]] || fail 'The existing Linear key file is empty.'
for file in scripts/dispatch/dispatch.ts scripts/dispatch/dispatch.lock scripts/dispatch/.node-version deploy/factory-dispatch.service deploy/factory-dispatch.timer; do
    [[ -f "$root/$file" && ! -L "$root/$file" ]] || fail "Missing/unsafe artifact: $file"
done
for unit in factory-dispatch.service factory-dispatch.timer; do
    [[ ! -L "/etc/systemd/system/$unit" ]] || fail "Refusing symlink unit: $unit"
done
[[ -z $(systemctl show factory-dispatch.timer --property=DropInPaths --value) ]] || fail 'Review/remove factory-dispatch.timer drop-ins before installing.'
# Same grammar as DISPATCH_RUNNER_CAPS in scripts/dispatch/dispatch.ts: unique
# gpu|console=<positive safe integer> entries separated by commas.
valid_caps() {
    local item seen=,
    [[ $1 =~ ^(gpu|console)=[0-9]+(,(gpu|console)=[0-9]+)*$ ]] || return 1
    for item in ${1//,/ }; do
        [[ $seen != *",${item%%=*},"* && ${item#*=} =~ ^0*([1-9][0-9]{0,15})$ ]] || return 1
        (( BASH_REMATCH[1] <= 9007199254740991 )) || return 1
        seen+="${item%%=*},"
    done
}
service_dropins=$(systemctl show factory-dispatch.service --property=DropInPaths --value)
[[ -z $service_dropins || $service_dropins == "$caps_dropin" ]] ||
    fail "Review/remove factory-dispatch.service drop-ins; only $caps_dropin is accepted. Found: $service_dropins"
caps=absent
# Also check an on-disk file that systemd has not loaded yet: daemon-reload below would load it.
if [[ -e $caps_dropin || -L $caps_dropin ]]; then
    [[ ! -L $caps_dropin && -f $caps_dropin ]] || fail "Require a regular file, not a symlink: $caps_dropin"
    read -r owner mode < <(stat -c '%U %a' "$caps_dropin")
    [[ $owner == root ]] || fail "Require root ownership: sudo chown root $caps_dropin"
    (( (8#$mode & 8#022) == 0 )) || fail "Require no group/world write (mode $mode): sudo chmod go-w $caps_dropin"
    header=0 caps='' number=0
    while IFS= read -r line || [[ -n $line ]]; do
        number=$((number + 1))
        # A trailing backslash continues the line in systemd, even after a comment.
        if [[ $line != *\\ && $line =~ ^[[:space:]]*(#.*)?$ ]]; then
            continue
        elif [[ $line == '[Service]' && $header == 0 ]]; then
            header=1
        elif [[ $line == Environment=DISPATCH_RUNNER_CAPS=* && $header == 1 && -z $caps ]]; then
            caps=${line#Environment=DISPATCH_RUNNER_CAPS=}
            valid_caps "$caps" || fail "Invalid DISPATCH_RUNNER_CAPS at $caps_dropin line $number: $caps (want unique gpu|console=<positive integer> entries separated by commas)"
        else
            # Print only the key: an unexpected Environment= line could hold a secret.
            fail "Unexpected $caps_dropin line $number: ${line%%=*}; allowed are blank lines, # comments, one [Service] and one Environment=DISPATCH_RUNNER_CAPS=<caps> line"
        fi
    done < "$caps_dropin"
    [[ -n $caps ]] || fail "Missing [Service] Environment=DISPATCH_RUNNER_CAPS=<caps> line in $caps_dropin"
fi
printf 'Runner caps drop-in: %s\n' "$caps"
# A readable cwd is essential for the agent's Vite+ Node shim.
cd /home/agent/work
# Heredocs avoid sudo -i script quoting and preserve the runner JSON on stdin.
node=$(sudo -iu agent bash -s <<'LOOKUP'
cd /home/agent/work && command -v node
LOOKUP
)
amp=$(sudo -iu agent bash -s <<'LOOKUP'
cd /home/agent/work && command -v amp
LOOKUP
)
[[ "$node" =~ ^/[a-zA-Z0-9_./-]+$ && "$amp" =~ ^/[a-zA-Z0-9_./-]+$ ]] || fail 'Node and Amp must resolve to absolute executable paths without spaces.'
path="$(dirname "$node"):$(dirname "$amp"):/usr/local/bin:/usr/bin:/bin"
as_agent() { sudo -u agent env -i HOME=/home/agent USER=agent PATH="$path" "$@"; }
supported_node() { [[ $1 =~ ^v?24\.([0-9]+)\.([0-9]+)$ && ${BASH_REMATCH[1]} -ge 12 ]]; }
node_version=$(as_agent "$node" --version)
supported_node "$node_version" || fail "Use Node 24.x (>= 24.12.0); found $node_version"
as_agent "$amp" --version
local_runners=$(as_agent "$amp" runner list --json)
[[ ! -t 0 ]] || fail 'Pipe fresh console amp runner list --json into this installer; see scripts/dispatch/README.md.'
console_runners=$(cat)
# Amp's CLI lists only machine-local runners. The Mac supplies console's read.
as_agent "$node" --input-type=module -e '
const [local, remote] = process.argv.slice(1).map(JSON.parse);
for (const [listing, id] of [[local, "factory-gpu"], [remote, "factory-console"]]) {
  if (!listing.runners?.some(r => r.runnerId === id && r.workingDirectory === "/home/agent/work" && r.serveCwd)) {
    throw new Error("Runner " + id + " must serve /home/agent/work");
  }
  console.log("Verified runner listing: " + id);
}' "$local_runners" "$console_runners"
as_agent "$node" "$root/scripts/dispatch/dispatch.ts" poll --dry-run

# Snapshot before changing units. Reinstallation keeps the key and login intact.
install -d -o root -g root -m 0700 /var/backups/factory-dispatch
snapshot=$(mktemp -d "/var/backups/factory-dispatch/$(date -u +%Y%m%dT%H%M%S).XXXXXX")
for unit in factory-dispatch.service factory-dispatch.timer; do
    if [[ -e "/etc/systemd/system/$unit" ]]; then cp -p "/etc/systemd/system/$unit" "$snapshot/$unit"; else : > "$snapshot/$unit.missing"; fi
    systemctl is-enabled "$unit" > "$snapshot/$unit.enabled" 2>/dev/null || true
    systemctl is-active "$unit" > "$snapshot/$unit.active" 2>/dev/null || true
done
# Recorded for reference only; install and rollback never change the drop-in.
if [[ $caps == absent ]]; then : > "$snapshot/cap.conf.missing"; else cp -p "$caps_dropin" "$snapshot/cap.conf"; fi
printf 'Snapshot: %s (runner caps drop-in %s, recorded but never changed by install or rollback)\n' "$snapshot" "$caps"
if [[ $(systemctl show factory-dispatch.timer --property=LoadState --value) != not-found ]]; then systemctl stop factory-dispatch.timer; fi
# Wait for the existing pass; hold the same inode through installation.
exec 9<"$root/scripts/dispatch/dispatch.lock"
flock --exclusive 9
sed -e "s|@NODE@|$node|g" -e "s|@PATH@|$path|g" "$root/deploy/factory-dispatch.service" > "$snapshot/new.service"
install -o root -g root -m 0644 "$snapshot/new.service" /etc/systemd/system/factory-dispatch.service
install -o root -g root -m 0644 "$root/deploy/factory-dispatch.timer" /etc/systemd/system/factory-dispatch.timer
systemctl daemon-reload
systemctl enable --now factory-dispatch.timer
systemctl is-active --quiet factory-dispatch.timer
systemctl is-enabled --quiet factory-dispatch.timer
printf '%s\n' 'Dispatcher timer enabled. No application service or Amp runner changed.' \
    'Watch: gpu-ssh '\''sudo journalctl -u factory-dispatch -f'\'''
