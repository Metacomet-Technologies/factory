#!/usr/bin/env bash
set -Eeuo pipefail
umask 0027
here=$(dirname "$(realpath "$0")")
# shellcheck source=deploy/backup/nodes.conf
source "${BACKUP_CONFIG:-$here/nodes.conf}"
export PUBLISHED_STATUS R2_ENABLED
state=$here/backup-state.py

if [[ ${1:-} == --check-access ]]; then
    # Installer and runtime call this as factory-backup, not root. Test actual
    # kernel access (including ancestor traversal), not merely directory modes.
    [[ -d "$REPLICA_ROOT" && -r "$REPLICA_ROOT" && -x "$REPLICA_ROOT" && -w "$REPLICA_ROOT" ]] || {
        printf 'Cannot traverse/read/write replica root: %s\n' "$REPLICA_ROOT" >&2; exit 1;
    }
    [[ -d "$BACKUP_HOME" && -x "$BACKUP_HOME" && -w "$BACKUP_HOME" ]] || {
        printf 'Cannot traverse/write backup home: %s\n' "$BACKUP_HOME" >&2; exit 1;
    }
    known=$BACKUP_HOME/known_hosts
    [[ ! -L "$known" && ( ! -e "$known" || -f "$known" ) ]] || {
        printf 'Unsafe known_hosts file: %s\n' "$known" >&2; exit 1;
    }
    umask 0077
    : >> "$known"
    [[ -r "$known" && -w "$known" ]] || { echo 'Cannot read/write known_hosts' >&2; exit 1; }
    probe=$(mktemp "$REPLICA_ROOT/.access.XXXXXX")
    rm -- "$probe"
    [[ -r "$LOCAL_ROOT/$BACKUP_HOST" && -x "$LOCAL_ROOT/$BACKUP_HOST" ]] || {
        echo 'Cannot read local snapshot tree' >&2; exit 1;
    }
    echo 'Replica traversal/write and known_hosts read/write checks passed.'
    exit 0
fi

if [[ ${1:-} == --prune-replica ]]; then
    # Runs on the receiver as factory-backup, never as the sender's root user.
    exec python3 "$state" prune "$REPLICA_ROOT/$PEER" "${PEER_DBS[@]}"
fi

if [[ ${1:-} == --snapshot ]]; then
    name=$2 db=$3
    [[ -f "$db" ]] || { printf 'Database missing: %s\n' "$db" >&2; exit 1; }
    directory=$LOCAL_ROOT/$BACKUP_HOST/$name
    mkdir -p "$directory"
    temp=$(mktemp -d "$directory/.snapshot.XXXXXX")
    trap 'rm -rf -- "$temp"' EXIT
    db=$(realpath "$db")
    # A relative destination avoids SQLite dot-command escaping of temp paths.
    (cd "$temp" && sqlite3 -readonly -cmd '.timeout 30000' "$db" ".backup 'copy.db'")
    integrity=$(sqlite3 -readonly "$temp/copy.db" 'PRAGMA integrity_check;')
    [[ "$integrity" == ok ]] || { printf 'Integrity failed: %s\n' "$integrity" >&2; exit 1; }
    zstd -q -T1 "$temp/copy.db" -o "$temp/$STAMP.db.zst"
    (cd "$temp" && sha256sum "$STAMP.db.zst" > "$STAMP.db.zst.sha256")
    chmod 0640 "$temp/$STAMP.db.zst" "$temp/$STAMP.db.zst.sha256"
    if [[ ${BACKUP_TRANSPORT:-ssh} == ssh ]]; then
        chgrp "$BACKUP_USER" "$directory" "$temp/$STAMP.db.zst" "$temp/$STAMP.db.zst.sha256"
        chmod 0750 "$LOCAL_ROOT" "$LOCAL_ROOT/$BACKUP_HOST" "$directory"
        chgrp "$BACKUP_USER" "$LOCAL_ROOT" "$LOCAL_ROOT/$BACKUP_HOST"
    fi
    mv -- "$temp/$STAMP.db.zst" "$directory/"
    mv -- "$temp/$STAMP.db.zst.sha256" "$directory/"
    exit 0
fi

[[ $# -eq 0 ]] || { echo 'Usage: factory-backup.sh [--prune-replica|--check-access]' >&2; exit 1; }
mkdir -p "$(dirname "$STATUS_FILE")" "$LOCAL_ROOT/$BACKUP_HOST"
# Root's lock must not be under the SSH account's writable home.
exec 9>"$LOCAL_ROOT/.backup.lock"
flock -n 9 || { echo 'Backup already running' >&2; exit 1; }
names=()
for index in "${!DBS[@]}"; do
    entry=${DBS[index]}
    name=${entry%%:*} db=${entry#*:}
    if [[ $name == atuin && ! -e "$db" && ! -L "$db" ]]; then
        printf 'Skipping atuin: database not created yet: %s\n' "$db"
        unset 'DBS[index]'
        continue
    fi
    names+=("$name")
done
python3 "$state" attempt "$STATUS_FILE" "${names[@]}"
trap 'python3 "$state" fatal "$STATUS_FILE" "Backup failed at line $LINENO"; exit 1' ERR
# Receiver-only nodes retain their old originals for rollback. Do not push or
# prune that tree; replica retention is requested separately by the sender.
if (( ${#names[@]} == 0 )); then
    echo 'No originating databases; local archives preserved.'
    exit 0
fi
for command in sqlite3 zstd sha256sum rsync python3 flock; do
    command -v "$command" >/dev/null
done
if [[ ${BACKUP_TRANSPORT:-ssh} == ssh ]]; then
    runuser -u "$BACKUP_USER" -- bash "$here/factory-backup.sh" --check-access
fi
export STAMP
STAMP=$(date -u +%Y%m%dT%H%M%S.%NZ)
failed=0
for entry in "${DBS[@]}"; do
    name=${entry%%:*} db=${entry#*:}
    if error=$(bash "$here/factory-backup.sh" --snapshot "$name" "$db" 2>&1); then
        size=$(stat -c %s "$LOCAL_ROOT/$BACKUP_HOST/$name/$STAMP.db.zst")
        python3 "$state" result "$STATUS_FILE" "$name" "$size" ok false 'Peer push pending'
    else
        printf '%s: %s\n' "$name" "$error" >&2
        python3 "$state" result "$STATUS_FILE" "$name" 0 failed false "$error"
        failed=1
    fi
done
# A failed DB blocks all network writes and all retention, even for other DBs.
(( failed == 0 )) || exit 1
push() {
    case ${BACKUP_TRANSPORT:-ssh} in
        ssh)
            runuser -u "$BACKUP_USER" -- rsync -a --partial --exclude='.snapshot.*' \
                -e "ssh ${SSH_OPTIONS[*]}" \
                "$LOCAL_ROOT/$BACKUP_HOST/" "$BACKUP_USER@$PEER:$PEER_REPLICA_ROOT/$BACKUP_HOST/"
            ;;
        local)
            mkdir -p "$PEER_REPLICA_ROOT/$BACKUP_HOST" || return
            rsync -a --partial --exclude='.snapshot.*' "$LOCAL_ROOT/$BACKUP_HOST/" "$PEER_REPLICA_ROOT/$BACKUP_HOST/"
            ;;
        *) echo 'BACKUP_TRANSPORT must be ssh or local' >&2; return 1 ;;
    esac
}
if error=$(push 2>&1); then
    printf '%s\n' "$error"
    for name in "${names[@]}"; do
        size=$(stat -c %s "$LOCAL_ROOT/$BACKUP_HOST/$name/$STAMP.db.zst")
        python3 "$state" result "$STATUS_FILE" "$name" "$size" ok true 'Retention pending'
    done
else
    printf 'Peer push failed: %s\n' "$error" >&2
    for name in "${names[@]}"; do
        size=$(stat -c %s "$LOCAL_ROOT/$BACKUP_HOST/$name/$STAMP.db.zst")
        python3 "$state" result "$STATUS_FILE" "$name" "$size" ok false "$error"
    done
    exit 1
fi
if [[ ${BACKUP_TRANSPORT:-ssh} == ssh ]]; then
    runuser -u "$BACKUP_USER" -- ssh "${SSH_OPTIONS[@]}" "$BACKUP_USER@$PEER" \
        env BACKUP_CONFIG=/etc/factory-backup/nodes.conf \
        /usr/local/lib/factory-backup/factory-backup.sh --prune-replica
else
    python3 "$state" prune "$PEER_REPLICA_ROOT/$BACKUP_HOST" "${names[@]}"
fi
python3 "$state" prune "$LOCAL_ROOT/$BACKUP_HOST" "${names[@]}"
for name in "${names[@]}"; do
    size=$(stat -c %s "$LOCAL_ROOT/$BACKUP_HOST/$name/$STAMP.db.zst")
    python3 "$state" result "$STATUS_FILE" "$name" "$size" ok true ''
done
if [[ ${R2_ENABLED:-0} == 1 ]]; then
    python3 "$state" offsite "$STATUS_FILE" pending
    if timeout --kill-after=10s 15m "${R2_PYTHON:-python3}" "$here/offsite.py" \
        --endpoint "${R2_ENDPOINT:-}" --bucket "${R2_BUCKET:-}" push \
        --root "$LOCAL_ROOT" --host "$BACKUP_HOST" --stamp "$STAMP" \
        --recipient "${R2_RECIPIENT_FILE:-}" "${names[@]}"; then
        python3 "$state" offsite "$STATUS_FILE" ok
    else
        python3 "$state" offsite "$STATUS_FILE" failed
        echo 'Off-site push failed; local backup, peer push and retention succeeded.' >&2
    fi
fi
