#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run as root: bash deploy/rollback-meter-v1.sh <snapshot-directory>.'
[[ $# -eq 1 ]] || fail 'Supply the exact installer snapshot directory.'
snapshot=$(realpath "$1")
db=/srv/factory/meter/meter.db
legacy=/srv/factory/meter/meter.v0.db
trap 'printf "ERROR: rollback failed at line %s; snapshot retained at %s. Meter may remain stopped.\n" "$LINENO" "$snapshot" >&2' ERR
for command in systemctl cp rm cat mv mktemp date sudo curl touch sqlite3 flock realpath chmod chown cmp dirname sleep; do
    command -v "$command" >/dev/null || fail "Required command missing: $command"
done
[[ -f "$snapshot/complete" && -f "$snapshot/enabled" && -f "$snapshot/active" && -f "$snapshot/mode" ]] || fail 'Snapshot is incomplete.'
for name in binary unit; do
    if [[ -f "$snapshot/$name" && ! -e "$snapshot/$name.missing" ]]; then :
    elif [[ -f "$snapshot/$name.missing" && ! -e "$snapshot/$name" ]]; then :
    else fail "Invalid snapshot entry: $name"; fi
done
mode=$(cat "$snapshot/mode")
enabled=$(cat "$snapshot/enabled")
active=$(cat "$snapshot/active")
case "$mode" in legacy|fresh|v1) ;; *) fail "Invalid DB mode: $mode" ;; esac
case "$enabled" in enabled|disabled|static|indirect|not-found) ;; *) fail "Invalid enable state: $enabled" ;; esac
case "$active" in active|inactive|failed|unknown) ;; *) fail "Invalid active state: $active" ;; esac
[[ ! -d /etc/systemd/system/meter.service.d ]] || fail 'Review meter unit drop-ins first.'
[[ -z $(systemctl show meter.service --property=DropInPaths --value) ]] || fail 'Review meter unit drop-ins first.'
for path in /usr/local/bin/meter /etc/systemd/system/meter.service "$db" "$db-wal" "$db-shm" "$legacy" "$legacy-wal" "$legacy-shm" /var/backups/factory-db/.backup.lock; do
    [[ ! -L "$path" && ( ! -e "$path" || -f "$path" ) ]] || fail "Unsafe destination: $path"
    parent=$(dirname "$path")
    while [[ "$parent" != / ]]; do
        [[ ! -L "$parent" && ( ! -e "$parent" || -d "$parent" ) ]] || fail "Unsafe directory: $parent"
        parent=$(dirname "$parent")
    done
done
source_name=meter.db
[[ "$mode" != legacy ]] || source_name=meter.v0.db
if [[ -f "$snapshot/db-changing" ]]; then
    [[ -f "$snapshot/db-ready" ]] || fail 'DB snapshot is incomplete.'
    if [[ "$mode" != fresh ]]; then
        [[ -f "$snapshot/$source_name" ]] || fail 'Previous DB generation is missing.'
        # Use a disposable copy: SQLite must not modify preserved sidecars.
        check=$(mktemp -d)
        trap 'rm -rf -- "$check"' EXIT
        for suffix in '' -wal -shm; do
            if [[ -f "$snapshot/$source_name$suffix" ]]; then cp -p -- "$snapshot/$source_name$suffix" "$check/meter.db$suffix"; fi
        done
        expected=1
        [[ "$mode" != legacy ]] || expected=0
        [[ $(sqlite3 -readonly "$check/meter.db" 'PRAGMA user_version;') == "$expected" ]] || fail 'Snapshot schema version does not match previous binary generation.'
        [[ $(sqlite3 -readonly "$check/meter.db" 'PRAGMA integrity_check;') == ok ]] || fail 'Snapshot integrity failed.'
    fi
fi
[[ -d /var/backups/factory-db ]] || fail 'MET-74 backup lock is unavailable.'
exec 9>>/var/backups/factory-db/.backup.lock
flock -n 9 || fail 'Backup or deployment is running; retry later.'
if [[ "$mode" == legacy && -f "$snapshot/legacy-preserved" && ! -f "$snapshot/db-restored" ]]; then
    for suffix in '' -wal -shm; do
        if [[ -f "$snapshot/meter.v0.db$suffix" ]]; then
            cmp -s "$snapshot/meter.v0.db$suffix" "$legacy$suffix" || fail "Preserved v0 differs from its stopped snapshot: $legacy$suffix"
        else
            [[ ! -e "$legacy$suffix" ]] || fail "Unexpected preserved v0 sidecar: $legacy$suffix"
        fi
    done
fi
if [[ $(systemctl show meter.service --property=LoadState --value) != not-found ]]; then
    systemctl stop meter.service
    systemctl disable meter.service
fi
if [[ -f "$snapshot/db-changing" && ! -f "$snapshot/db-restored" ]]; then
    recovery=$(mktemp -d "$snapshot/recovery-$(date -u +%Y%m%dT%H%M%S.%NZ).XXXXXX")
    # Remove the entire current generation before restoring any old sidecars.
    for suffix in -wal -shm ''; do
        if [[ -e "$db$suffix" ]]; then mv -- "$db$suffix" "$recovery/meter.db$suffix"; fi
    done
    if [[ "$mode" == legacy && -f "$snapshot/legacy-preserved" ]]; then
        [[ -f "$legacy" ]] || fail 'Preserved meter.v0.db is missing; use the verified snapshot for manual recovery.'
        for suffix in -wal -shm ''; do
            if [[ -f "$legacy$suffix" ]]; then
                mv -- "$legacy$suffix" "$db$suffix"
                chown meter:meter "$db$suffix"
                chmod 0600 "$db$suffix"
            fi
        done
    elif [[ "$mode" != fresh ]]; then
        # A failed partial swap has no complete v0 generation. Preserve its
        # fragments and recover the matching stopped generation from the snapshot.
        if [[ "$mode" == legacy ]]; then
            for suffix in -wal -shm ''; do
                if [[ -f "$legacy$suffix" ]]; then mv -- "$legacy$suffix" "$recovery/meter.v0.db$suffix"; fi
            done
        fi
        for suffix in -wal -shm ''; do
            if [[ -f "$snapshot/$source_name$suffix" ]]; then
                cp -p -- "$snapshot/$source_name$suffix" "$db$suffix"
                chown meter:meter "$db$suffix"
                chmod 0600 "$db$suffix"
            fi
        done
    fi
    touch "$snapshot/db-restored"
    printf 'Current DB+WAL/SHM retained at: %s\nPost-migration rows remain in recovery; they are NOT restored.\n' "$recovery"
fi
for name in binary unit; do
    path=/usr/local/bin/meter
    [[ "$name" != unit ]] || path=/etc/systemd/system/meter.service
    if [[ -f "$snapshot/$name.missing" ]]; then rm -f -- "$path"
    else cp -p -- "$snapshot/$name" "$path"; fi
done
systemctl daemon-reload
if [[ "$enabled" == enabled ]]; then systemctl enable meter.service; fi
if [[ "$active" == active ]]; then
    [[ -f /usr/local/bin/meter && -f /etc/systemd/system/meter.service ]] || fail 'Cannot restart: prior binary/unit missing.'
    systemctl start meter.service
    deadline=$((SECONDS + 45))
    while (( SECONDS < deadline )); do
        remaining=$((deadline - SECONDS))
        (( remaining > 2 )) && remaining=2
        if sudo -u meter curl -fs --max-time "$remaining" -o /dev/null http://127.0.0.1:11434/meter/health 2>/dev/null; then break; fi
        if (( SECONDS < deadline )); then sleep 1; fi
    done
    sudo -u meter curl -fsS --max-time 2 http://127.0.0.1:11434/meter/health
    systemctl is-active --quiet meter.service
fi
printf '\nMeter snapshot restored: %s\nPrior enabled: %s; active: %s (failed/unknown restored as stopped).\nOllama was not changed. Original migration snapshot remains available.\n' "$snapshot" "$enabled" "$active"
