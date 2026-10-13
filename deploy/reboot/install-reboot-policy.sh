#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
here=$(dirname "$(realpath "$0")")
snapshot=
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run as root: sudo bash deploy/reboot/install-reboot-policy.sh [--mode observe|enforce] [--node factory-gpu|factory-console] [--replace-config]'
trap 'printf "ERROR: reboot-policy installation failed at line %s. Snapshot: %s. Disable/remove policy with: sudo bash %s/rollback-reboot-policy.sh\n" "$LINENO" "${snapshot:-not created}" "$here" >&2' ERR
# Never inherit harness roots, clocks, configuration or fake commands as root.
unset REBOOT_ROOT REBOOT_CONFIG REBOOT_NOW_MS REBOOT_POSTBOOT_WAIT_S PYTHONPATH PYTHONHOME
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
mode=observe
replace_config=false
node=$(hostname -s)
while (( $# )); do
    case "$1" in
        --mode) [[ $# -ge 2 ]] || fail 'Missing --mode value'; mode=$2; shift 2 ;;
        --node) [[ $# -ge 2 ]] || fail 'Missing --node value'; node=$2; shift 2 ;;
        --replace-config) replace_config=true; shift ;;
        *) fail "Unknown argument: $1" ;;
    esac
done
[[ $mode == observe || $mode == enforce ]] || fail 'Mode must be observe or enforce.'
[[ $node == factory-gpu || $node == factory-console ]] || fail 'Unsupported hostname/node.'
[[ $node == "$(hostname -s)" ]] || fail '--node must match the hostname.'

# Read-only preflight, before any deployment changes.
for tool in python3 systemctl systemd-analyze ps timedatectl install realpath dirname \
    hostname cp cmp mktemp mv rm date chmod; do
    command -v "$tool" >/dev/null || fail "Missing tool: $tool"
done
if [[ $node == factory-gpu ]]; then
    for tool in curl upsc; do command -v "$tool" >/dev/null || fail "Missing tool: $tool"; done
fi
python3 -c 'from zoneinfo import ZoneInfo; ZoneInfo("America/New_York")'
[[ -d /run/systemd/system ]] || fail 'systemd is not running.'
systemctl show --property=Version --value >/dev/null
for file in reboot-policy.py reboot-check.sh postboot-check.sh factory-reboot.service \
    factory-postboot.service factory-reboot.timer "$node.conf"; do
    [[ -r $here/$file ]] || fail "Missing artifact: $file"
done
config=/etc/factory-reboot/node.conf
lib=/usr/local/lib/factory-reboot
units=/etc/systemd/system
for path in "$config" "$lib" /var/lib/factory-reboot /var/backups/factory-reboot \
    "$units/factory-reboot.service" "$units/factory-reboot.timer" "$units/factory-postboot.service"; do
    parent=$path
    while [[ $parent != / ]]; do
        [[ ! -L $parent ]] || fail "Refusing symlink destination: $parent"
        parent=$(dirname "$parent")
    done
done
for file in reboot-policy.py reboot-check.sh postboot-check.sh; do
    [[ ! -L $lib/$file ]] || fail "Refusing symlink destination: $lib/$file"
done
for unit in factory-reboot.service factory-reboot.timer factory-postboot.service; do
    [[ -z $(systemctl show "$unit" --property=DropInPaths --value) ]] || fail "Review $unit drop-ins first."
    enabled=$(systemctl is-enabled "$unit" 2>/dev/null || true)
    case "$enabled" in enabled|disabled|static|indirect|not-found) ;; *) fail "Unsupported state: $unit $enabled" ;; esac
done
# Preserve local edits unless the operator explicitly requests repository defaults.
source_config=$here/$node.conf
if [[ -f $config && $replace_config == false ]]; then source_config=$config; fi
calendar=$(python3 - "$source_config" "$node" <<'PY'
import json, re, sys
data = json.load(open(sys.argv[1]))
assert data['node'] == sys.argv[2], 'Existing configuration belongs to another node'
expected = '*-*-* ' + ('06:00' if data['node'] == 'factory-gpu' else '06:30') + ' America/New_York'
assert data['calendar'] == expected, 'Unexpected reboot window'
assert data['mode'] in ('observe', 'enforce')
for rule in data['agent_allowlist']:
    re.compile(rule['args'])
    if 'parent_args' in rule:
        re.compile(rule['parent_args'])
assert all(isinstance(service, str) and not service.startswith('-') for service in data['services'])
print(expected)
PY
)
# Ubuntu 26.04 supports timezone calendars; refuse unsupported hosts, not a DST-unsafe fallback.
systemd-analyze calendar "$calendar" >/dev/null

install -d -m 0700 /var/backups/factory-reboot
snapshot=$(mktemp -d "/var/backups/factory-reboot/$(date -u +%Y%m%dT%H%M%S).XXXXXX")
for path in "$config" "$lib" "$units/factory-reboot.service" \
    "$units/factory-reboot.timer" "$units/factory-postboot.service"; do
    if [[ -e $path ]]; then cp -a --parents "$path" "$snapshot/"; fi
done
printf 'Snapshot: %s\n' "$snapshot"
rendered=$snapshot/factory-reboot.timer
python3 - "$here/factory-reboot.timer" "$calendar" "$rendered" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[3]).write_text(Path(sys.argv[1]).read_text().replace('@CALENDAR@', sys.argv[2]))
PY
unchanged=true
for file in reboot-policy.py reboot-check.sh postboot-check.sh; do
    cmp -s "$here/$file" "$lib/$file" || unchanged=false
done
for file in factory-reboot.service factory-postboot.service; do
    cmp -s "$here/$file" "$units/$file" || unchanged=false
done
cmp -s "$rendered" "$units/factory-reboot.timer" || unchanged=false
if [[ $unchanged == false ]]; then
    for unit in factory-reboot.timer factory-reboot.service factory-postboot.service; do
        if [[ $(systemctl show "$unit" --property=LoadState --value) != not-found ]]; then
            systemctl stop "$unit"
        fi
    done
    install -d -m 0755 "$lib" /etc/factory-reboot
    for file in reboot-check.sh postboot-check.sh; do install -m 0755 "$here/$file" "$lib/$file"; done
    install -m 0644 "$here/reboot-policy.py" "$lib/reboot-policy.py"
    for file in factory-reboot.service factory-postboot.service; do
        install -m 0644 "$here/$file" "$units/$file"
    done
    install -m 0644 "$rendered" "$units/factory-reboot.timer"
fi
# Publish the configuration atomically, including on a mode-only switch.
python3 - "$source_config" "$config" "$mode" <<'PY'
import json, os, sys, tempfile
data = json.load(open(sys.argv[1]))
data['mode'] = sys.argv[3]
with tempfile.NamedTemporaryFile(mode='w', dir=os.path.dirname(sys.argv[2]), delete=False) as out:
    json.dump(data, out, indent=2)
    out.write('\n')
    out.flush()
    os.fsync(out.fileno())
os.chmod(out.name, 0o644)
os.replace(out.name, sys.argv[2])
PY
if [[ $unchanged == false ]]; then systemctl daemon-reload; fi
systemctl enable --now factory-reboot.timer
systemctl enable factory-postboot.service
# Even an enforce installation must never reboot during its immediate probe.
"$lib/reboot-check.sh" --mode observe
python3 -m json.tool /var/lib/factory-reboot/status.json
printf 'Configured mode: %s. Immediate probe used observe; timer uses configured mode.\n' "$mode"
