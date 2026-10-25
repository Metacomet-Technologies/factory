#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run rollback-offsite-runtime.sh as root.'
[[ $# -eq 1 ]] || fail 'Usage: rollback-offsite-runtime.sh SNAPSHOT (disable R2 first)'
trap 'printf "ERROR: runtime rollback failed at line %s; backup data and credentials retained.\n" "$LINENO" >&2' ERR
runtime=/opt/factory-backup-r2
snapshot=$(realpath -e "$1")
[[ $snapshot == /opt/factory-backup-r2-snapshots/install.* && -d $snapshot && -f $snapshot/complete ]] || fail 'Invalid or incomplete snapshot.'
[[ ( -d $snapshot/runtime && ! -e $snapshot/absent ) || ( -f $snapshot/absent && ! -e $snapshot/runtime ) ]] || fail 'Invalid snapshot contents.'
for path in "$snapshot" "$snapshot/runtime" "$runtime"; do
    while [[ $path != / ]]; do
        [[ ! -L $path ]] || fail "Refusing symlink: $path"
        path=$(dirname "$path")
    done
done
exec 9</opt
flock -w 30 9
rm -rf -- "$runtime"
if [[ -d $snapshot/runtime ]]; then
    cp -a "$snapshot/runtime" "$runtime"
    timeout 30 "$runtime/bin/python" -I -c 'import boto3, pyrage'
else
    [[ ! -e $runtime ]]
fi
echo 'Runtime restored only; no units, credentials, identities or backups changed.'
