#!/usr/bin/env bash
# Restore the SMART helper files from an install snapshot. Does not run smartctl.
set -Eeuo pipefail
umask 0027
root=
if (( EUID != 0 )); then
    [[ -n ${DEVICES_TEST_ROOT:-} && -d $DEVICES_TEST_ROOT && $DEVICES_TEST_ROOT == /* && $DEVICES_TEST_ROOT != / ]] || { echo 'ERROR: Run as root.' >&2; exit 1; }
    root=$DEVICES_TEST_ROOT
fi
(( $# == 1 )) || { echo 'Usage: rollback-devices.sh SNAPSHOT' >&2; exit 1; }
snapshot=$1
[[ -d $snapshot ]] || { echo "ERROR: snapshot not found: $snapshot" >&2; exit 1; }
lib=$root/usr/local/lib/factory-devices
units=$root/etc/systemd/system
mkdir -p "$lib" "$units"
restore() {
    local name=$1 dest=$2
    if [[ -f $snapshot/$name.absent ]]; then
        rm -f "$dest"
    elif [[ -f $snapshot/$name ]]; then
        cp -a "$snapshot/$name" "$dest"
    fi
}
restore smart-snapshot.py "$lib/smart-snapshot.py"
restore factory-devices-smart.service "$units/factory-devices-smart.service"
restore factory-devices-smart.timer "$units/factory-devices-smart.timer"
if [[ -f $snapshot/factory-devices-maintenance.timer.absent ]]; then
    systemctl disable --now factory-devices-maintenance.timer
    systemctl stop factory-devices-maintenance.service
fi
restore maintenance-snapshot.py "$lib/maintenance-snapshot.py"
restore factory-devices-maintenance.service "$units/factory-devices-maintenance.service"
restore factory-devices-maintenance.timer "$units/factory-devices-maintenance.timer"
systemctl daemon-reload
echo "Restored device helper files from $snapshot"
