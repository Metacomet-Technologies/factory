#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
here=$(dirname "$(realpath "$0")")
# shellcheck source=deploy/ups/control-state.sh
source "$here/control-state.sh"
[[ $# == 1 && -d $1 && -f $1/complete ]] || fail 'Usage: rollback-ups-control.sh COMPLETE_SNAPSHOT'
snapshot=$(realpath "$1")
safe "$snapshot"
for path in "${files[@]}"; do safe "$root/$path"; done
for unit in "${units[@]}"; do
    [[ -f $snapshot/$unit.enabled && -f $snapshot/$unit.active ]] || fail 'Incomplete state snapshot.'
    case $(cat "$snapshot/$unit.enabled") in enabled|disabled|static|indirect|not-found) ;; *) fail 'Invalid saved enabled state.' ;; esac
    case $(cat "$snapshot/$unit.active") in active|inactive|unknown) ;; *) fail 'Invalid saved active state.' ;; esac
done
# Retain the displaced deployment too. Neither snapshot nor rollback removes DB data.
original=$snapshot
snapshot_files
snapshot=$original
stop_units
for unit in "${units[@]}"; do
    if [[ $(systemctl is-enabled "$unit" 2>/dev/null || true) == enabled ]]; then systemctl disable "$unit"; fi
done
for path in "${files[@]}"; do
    if [[ -f $snapshot/$path ]]; then
        cp -a -- "$snapshot/$path" "$root/$path"
    else
        rm -f -- "$root/$path"
    fi
done
systemctl daemon-reload
for unit in "${units[@]}"; do
    if [[ $(cat "$snapshot/$unit.enabled") == enabled ]]; then systemctl enable "$unit"; fi
    if [[ $(cat "$snapshot/$unit.active") == active ]]; then systemctl start "$unit"; fi
done
echo 'Prior files and enabled/running state restored. Audit DB retained untouched; never downgrade its schema automatically.'
echo 'Manual path-only routing removal (not executed): tailscale serve --bg --https=443 --set-path /control off'
