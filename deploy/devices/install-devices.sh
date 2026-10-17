#!/usr/bin/env bash
# Install the read-only SMART snapshot helper. Does not run smartctl.
set -Eeuo pipefail
umask 0027
here=$(dirname "$(realpath "$0")")
root=
if (( EUID != 0 )); then
    [[ -n ${DEVICES_TEST_ROOT:-} && -d $DEVICES_TEST_ROOT && $DEVICES_TEST_ROOT == /* && $DEVICES_TEST_ROOT != / ]] || { echo 'ERROR: Run as root.' >&2; exit 1; }
    root=$DEVICES_TEST_ROOT
fi
preflight=false
node=factory-gpu
usage='Usage: install-devices.sh [--preflight]'
while (( $# )); do
    case $1 in
        --preflight) preflight=true; shift ;;
        *) echo "ERROR: $usage" >&2; exit 1 ;;
    esac
done
for command in systemctl hostname install cmp python3; do
    command -v "$command" >/dev/null || { echo "ERROR: Required command missing: $command" >&2; exit 1; }
done
[[ $(hostname -s) == "$node" ]] || { echo "ERROR: This host is $(hostname -s), not $node; nothing changed." >&2; exit 1; }

lib=$root/usr/local/lib/factory-devices
state=$root/var/lib/factory-devices
units=$root/etc/systemd/system
helper=$lib/smart-snapshot.py
reboot=$root/var/lib/factory-reboot/status.json

if $preflight; then
    [[ -f $helper && -f $units/factory-devices-smart.service && -f $units/factory-devices-smart.timer ]] || { echo 'ERROR: devices helper is not installed.' >&2; exit 1; }
    cmp -s "$here/smart-snapshot.py" "$helper" || { echo 'ERROR: installed helper does not match this tree.' >&2; exit 1; }
    if [[ -r $reboot ]]; then
        echo 'Reboot status is readable.'
    else
        echo 'Reboot status is not readable. An administrator must publish a group-readable copy before the devices page can show reboot age.'
    fi
    exit 0
fi

stamp=$(date +%Y%m%d%H%M%S)
snapshot=$root/var/backups/factory-devices/$stamp
mkdir -p "$snapshot" "$lib" "$state" "$units"
for path in "$helper" "$units/factory-devices-smart.service" "$units/factory-devices-smart.timer"; do
    if [[ -f $path ]]; then
        cp -a "$path" "$snapshot/$(basename "$path")"
    else
        : > "$snapshot/$(basename "$path").absent"
    fi
done
install -m 0755 "$here/smart-snapshot.py" "$helper"
install -m 0644 "$here/factory-devices-smart.service" "$units/factory-devices-smart.service"
install -m 0644 "$here/factory-devices-smart.timer" "$units/factory-devices-smart.timer"
chmod 0750 "$state"
if [[ -z $root ]] && getent group factory-api >/dev/null; then
    chgrp factory-api "$state"
    [[ -e $state/smart.json ]] && chmod 0640 "$state/smart.json" && chgrp factory-api "$state/smart.json"
fi
systemctl daemon-reload
systemctl enable --now factory-devices-smart.timer
echo "Installed factory device SMART helper. Snapshot directory $state"
echo "Rollback: sudo bash $here/rollback-devices.sh $snapshot"
