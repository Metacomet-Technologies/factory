#!/usr/bin/env bash
# Console step. The administrator transports only bundle/ through their Mac.
set -Eeuo pipefail
umask 0077
here=$(dirname "$(realpath "$0")")
snapshot=/var/backups/factory-api-move/console
hint() { echo "Rollback: console-ssh 'sudo bash /home/agent/work/factory/deploy/rollback-move-factory-api.sh console' (stop GPU first if started)" >&2; }
fail() { echo "ERROR: $*" >&2; hint; exit 1; }
trap 'echo "Console preparation failed at line $LINENO" >&2; hint' ERR
[[ $# -le 1 && ( $# == 0 || $1 == --dry-run ) ]] || fail 'Usage: prepare-factory-api-move.sh [--dry-run]'
if [[ ${1:-} == --dry-run ]]; then
    echo 'Console: preflight; snapshot backup config; stop backup timer/service and API; MET-74 snapshot both DBs; verify bundle; disable API. No writes performed.'
    hint
    exit 0
fi
[[ $EUID == 0 && $(hostname -s) == factory-console ]] || fail 'Run as root on factory-console only.'
for command in systemctl python3 sqlite3 zstd sha256sum flock cp install env mv mktemp date; do command -v "$command" >/dev/null; done
for path in /var/backups/factory-api-move "$snapshot" /var/lib/factory-api /etc/factory-backup/nodes.conf; do
    [[ ! -L "$path" ]] || fail "Refusing symlink: $path"
done
[[ ! -e "$snapshot/rolled-back" ]] || fail 'Previous move was rolled back. Archive the move journal under a new name before a new move.'
for name in requests pricing; do
    [[ -f /var/lib/factory-api/$name.db && ! -L /var/lib/factory-api/$name.db ]] || fail "Missing/unsafe $name.db"
done
[[ -f /etc/factory-backup/nodes.conf && -d /var/backups/factory-db ]] || fail 'Install MET-74 first.'
[[ ! -L /var/backups/factory-db/.backup.lock ]] || fail 'Unsafe backup lock.'
[[ -z $(systemctl show factory-api.service --property=DropInPaths --value) ]] || fail 'Review API drop-ins first.'
install -d -m 0700 "$snapshot"
exec 8>"$snapshot/lock"
flock -n 8 || fail 'Another console move is running.'
# Keep the pre-move configuration across retries, including after new backups install.
if [[ ! -f "$snapshot/nodes.conf" ]]; then
    cp -p /etc/factory-backup/nodes.conf "$snapshot/nodes.conf.tmp"
    mv "$snapshot/nodes.conf.tmp" "$snapshot/nodes.conf"
fi
systemctl disable --now factory-backup.timer
systemctl stop factory-backup.service
systemctl disable --now factory-api.service
exec 9>>/var/backups/factory-db/.backup.lock
flock -n 9 || fail 'Another backup/deployment is running.'
if [[ ! -f "$snapshot/bundle/counts.json" ]]; then
    # Incomplete publication is private scratch, never the rollback DBs.
    stage=$(mktemp -d "$snapshot/stage.XXXXXX")
    export STAMP
    STAMP=$(date -u +%Y%m%dT%H%M%S.%NZ)
    for name in requests pricing; do
        env -i PATH="$PATH" STAMP="$STAMP" BACKUP_CONFIG="$here/backup/nodes.conf" \
            BACKUP_HOST=factory-console LOCAL_ROOT="$stage/local" BACKUP_TRANSPORT=local \
            bash "$here/backup/factory-backup.sh" --snapshot "$name" "/var/lib/factory-api/$name.db"
        archive=$stage/local/factory-console/$name/$STAMP.db.zst
        (cd "$(dirname "$archive")" && sha256sum --strict -c "$STAMP.db.zst.sha256")
        cp "$archive" "$stage/$name.db.zst"
        (cd "$stage" && sha256sum "$name.db.zst" > "$name.db.zst.sha256")
    done
    python3 "$here/move-db.py" manifest "$stage"
    publish=$(mktemp -d "$snapshot/bundle.XXXXXX")
    for file in requests.db.zst requests.db.zst.sha256 pricing.db.zst pricing.db.zst.sha256 counts.json; do
        install -m 0600 "$stage/$file" "$publish/$file"
    done
    [[ ! -e "$snapshot/bundle" ]] || fail 'Unexpected incomplete bundle; preserve and review it before retrying.'
    mv -T "$publish" "$snapshot/bundle"
fi
python3 "$here/move-db.py" verify "$snapshot/bundle"
echo "Console API and backup timer disabled. DBs remain in place. Transfer $snapshot/bundle, then run GPU step."
