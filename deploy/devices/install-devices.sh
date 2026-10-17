#!/usr/bin/env bash
# Install read-only device snapshot helpers. Does not run probes.
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
reboot=$root/var/lib/factory-reboot-status/status.json
artifacts=(smart-snapshot.py maintenance-snapshot.py factory-devices-smart.service factory-devices-smart.timer factory-devices-maintenance.service factory-devices-maintenance.timer)

for name in "${artifacts[@]}"; do
    [[ -f $here/$name && -r $here/$name ]] || { echo "ERROR: missing artifact: $name" >&2; exit 1; }
done

if $preflight; then
    for name in "${artifacts[@]}"; do
        destination=$units/$name
        [[ $name != *.py ]] || destination=$lib/$name
        cmp -s "$here/$name" "$destination" || { echo "ERROR: installed $name is missing or does not match this tree." >&2; exit 1; }
    done
    if [[ -r $reboot ]]; then
        echo 'Reboot status is readable.'
    else
        echo 'Reboot status is not readable. An administrator must publish a group-readable copy before the devices page can show reboot age.'
    fi
    exit 0
fi

stamp=$(date +%Y%m%d%H%M%S)
mkdir -p "$root/var/backups/factory-devices" "$lib" "$state" "$units"
snapshot=$(mktemp -d "$root/var/backups/factory-devices/$stamp.XXXXXX")
trap 'printf "ERROR: install failed at line %s. Rollback: sudo bash %q %q\n" "$LINENO" "$here/rollback-devices.sh" "$snapshot" >&2' ERR
for name in "${artifacts[@]}"; do
    path=$units/$name
    [[ $name != *.py ]] || path=$lib/$name
    if [[ -f $path ]]; then
        cp -a "$path" "$snapshot/$(basename "$path")"
    else
        : > "$snapshot/$(basename "$path").absent"
    fi
done
for name in "${artifacts[@]}"; do
    path=$units/$name
    mode=0644
    if [[ $name == *.py ]]; then path=$lib/$name; mode=0755; fi
    install -m "$mode" "$here/$name" "$path"
done
# Root installs use factory-api. Unprivileged tests supply DEVICES_TEST_GROUP.
group=
if [[ -n $root && -n ${DEVICES_TEST_GROUP:-} ]]; then
    group=$DEVICES_TEST_GROUP
elif [[ -z $root ]] && getent group factory-api >/dev/null; then
    group=factory-api
fi
if [[ -n $group ]]; then
    getent group "$group" >/dev/null || { echo "ERROR: group $group is missing." >&2; exit 1; }
    chgrp -- "$group" "$state"
    chmod 2750 "$state"
    for file in smart.json maintenance.json; do
        if [[ -f $state/$file && ! -L $state/$file ]]; then
            chgrp -- "$group" "$state/$file"
            chmod 0640 "$state/$file"
        fi
    done
else
    chmod 0750 "$state"
fi
systemctl daemon-reload
systemctl enable --now factory-devices-smart.timer
systemctl enable --now factory-devices-maintenance.timer
echo "Installed factory device snapshot helpers. Snapshot directory $state"
echo "Rollback: sudo bash $here/rollback-devices.sh $snapshot"
