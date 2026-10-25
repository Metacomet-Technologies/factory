#!/usr/bin/env bash
# Narrow configuration rollback, not an account or data rollback.
set -Eeuo pipefail
umask 0077
root=
if (( EUID != 0 )); then
    [[ -n ${BACKUP_TEST_ROOT:-} && -d $BACKUP_TEST_ROOT && $BACKUP_TEST_ROOT == /* && $BACKUP_TEST_ROOT != / ]] || { echo 'Run as root.' >&2; exit 1; }
    root=$BACKUP_TEST_ROOT
fi
files=(etc/factory-backup/nodes.conf usr/local/lib/factory-backup/nodes.conf
    usr/local/lib/factory-backup/backup-state.py usr/local/lib/factory-backup/factory-backup.sh
    usr/local/lib/factory-backup/restore-check.sh usr/local/lib/factory-backup/offsite.py
    etc/systemd/system/factory-backup.service etc/systemd/system/factory-backup.timer)
[[ $# == 1 ]] || { echo 'Usage: rollback-backup-config.sh --snapshot|SNAPSHOT' >&2; exit 1; }
for path in "${files[@]}"; do
    parent=$(dirname "$root/$path")
    while [[ $parent != / ]]; do
        [[ ! -L $parent ]] || { echo 'Unsafe config parent' >&2; exit 1; }
        parent=$(dirname "$parent")
    done
done
if [[ $1 == --snapshot ]]; then
    mkdir -p "$root/var/backups"
    snapshot=$(mktemp -d "$root/var/backups/backup-config.XXXXXX")
    for path in "${files[@]}"; do
        if [[ -e $root/$path || -L $root/$path ]]; then
            mkdir -p "$snapshot/$(dirname "$path")"
            cp -a -- "$root/$path" "$snapshot/$path"
        fi
    done
    for unit in factory-backup.service factory-backup.timer; do
        systemctl is-enabled "$unit" > "$snapshot/$unit.enabled" 2>/dev/null || true
        systemctl is-active "$unit" > "$snapshot/$unit.active" 2>/dev/null || true
    done
    if [[ -n ${PUBLISHED_STATUS:-} && ! -e $(dirname "$PUBLISHED_STATUS") ]]; then
        printf '%s\n' "$PUBLISHED_STATUS" > "$snapshot/published-status.created"
    fi
    touch "$snapshot/complete"
    printf 'Configuration rollback: bash %q %q\n' "$(realpath "$0")" "$snapshot"
    exit 0
fi
snapshot=$(realpath "$1")
[[ -d $snapshot && ! -L $snapshot && -f $snapshot/complete ]] || { echo 'Incomplete snapshot' >&2; exit 1; }
for unit in factory-backup.service factory-backup.timer; do
    case $(cat "$snapshot/$unit.enabled") in enabled|disabled|static|indirect|not-found) ;; *) exit 1 ;; esac
    case $(cat "$snapshot/$unit.active") in active|inactive|unknown) ;; *) exit 1 ;; esac
done
for unit in factory-backup.timer factory-backup.service; do
    if [[ $(systemctl show "$unit" -p LoadState --value) != not-found ]]; then
        systemctl stop "$unit"
        if [[ $(systemctl is-enabled "$unit" 2>/dev/null || true) == enabled ]]; then systemctl disable "$unit"; fi
    fi
done
for path in "${files[@]}"; do
    rm -f -- "$root/$path"
    if [[ -e $snapshot/$path || -L $snapshot/$path ]]; then
        mkdir -p "$(dirname "$root/$path")"
        cp -a -- "$snapshot/$path" "$root/$path"
    fi
done
if [[ -f "$snapshot/published-status.created" ]]; then
    published=$(cat "$snapshot/published-status.created")
    [[ $published == /* && $(dirname "$published") != / ]] || { echo 'Unsafe published status path' >&2; exit 1; }
    parent=$published
    while [[ $parent != / ]]; do
        [[ ! -L $parent ]] || { echo 'Unsafe published status parent' >&2; exit 1; }
        parent=$(dirname "$parent")
    done
    rm -f -- "$published"
    if [[ -d $(dirname "$published") ]]; then rmdir -- "$(dirname "$published")"; fi
fi
systemctl daemon-reload
for unit in factory-backup.service factory-backup.timer; do
    if [[ $(cat "$snapshot/$unit.enabled") == enabled ]]; then systemctl enable "$unit"; fi
    if [[ $(cat "$snapshot/$unit.active") == active ]]; then systemctl start "$unit"; fi
done
echo 'Backup configuration restored; accounts, DBs, archives and host keys preserved.'
