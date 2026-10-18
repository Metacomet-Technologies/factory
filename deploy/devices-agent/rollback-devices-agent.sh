#!/usr/bin/env bash
# Stop and remove the factory-console devices agent, and restore the SMART
# helper files recorded in an install snapshot (removed if that install added
# them). The token file stays unless --remove-token is given. The
# factory-devices user, its groups and /var/lib/factory-devices stay.
# Never touches factory-api.
# Usage: rollback-devices-agent.sh SNAPSHOT [--remove-token]
set -Eeuo pipefail
umask 0077
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage='Usage: rollback-devices-agent.sh SNAPSHOT [--remove-token]'
root=
if (( EUID != 0 )); then
    [[ -n ${DEVICES_AGENT_TEST_ROOT:-} && -d $DEVICES_AGENT_TEST_ROOT && $DEVICES_AGENT_TEST_ROOT == /* && $DEVICES_AGENT_TEST_ROOT != / ]] \
        || fail "Run as root. $usage"
    root=$DEVICES_AGENT_TEST_ROOT
else
    unset DEVICES_AGENT_TEST_ROOT
    export PATH=/usr/sbin:/usr/bin:/sbin:/bin
fi
snapshot=
remove_token=false
while (( $# )); do
    case $1 in
        --remove-token) remove_token=true; shift ;;
        -*) fail "$usage" ;;
        *) [[ -z $snapshot ]] || fail "$usage"; snapshot=$1; shift ;;
    esac
done
[[ -n $snapshot && -d $snapshot ]] || fail "Snapshot not found. $usage"
[[ $(hostname -s) == factory-console ]] || fail "This host is $(hostname -s), not factory-console; nothing changed."
units=$root/etc/systemd/system
lib=$root/usr/local/lib/factory-devices

systemctl disable --now factory-devices-agent.service || true
rm -f "$units/factory-devices-agent.service" "$root/usr/local/bin/factory-devices-agent"
echo 'Removed factory-devices-agent unit and binary.'

if [[ -f $snapshot/factory-devices-smart.timer.absent ]]; then
    systemctl disable --now factory-devices-smart.timer || true
    systemctl stop factory-devices-smart.service || true
fi
restore() {
    local name=$1 destination=$2
    if [[ -f $snapshot/$name.absent ]]; then
        rm -f "$destination"
    elif [[ -f $snapshot/$name ]]; then
        cp -a "$snapshot/$name" "$destination"
    fi
}
restore smart-snapshot.py "$lib/smart-snapshot.py"
restore factory-devices-smart.service "$units/factory-devices-smart.service"
restore factory-devices-smart.timer "$units/factory-devices-smart.timer"
restore console.conf "$units/factory-devices-smart.service.d/console.conf"
rmdir "$units/factory-devices-smart.service.d" 2>/dev/null || true
echo "Restored SMART helper files from $snapshot"

if $remove_token; then
    rm -f "$root/etc/factory-devices-agent/token"
    rmdir "$root/etc/factory-devices-agent" 2>/dev/null || true
    echo 'Removed the token file.'
else
    echo 'Kept /etc/factory-devices-agent/token (pass --remove-token to delete it).'
fi
systemctl daemon-reload
