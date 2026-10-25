#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run rollback-environment-cleanup.sh as root.'
trap 'printf "ERROR: environment rollback failed at line %s.\n" "$LINENO" >&2' ERR
[[ $# -eq 1 ]] || fail 'Usage: rollback-environment-cleanup.sh SNAPSHOT'
case $(hostname -s) in factory-gpu|factory-console) ;; *) fail 'Factory nodes only.' ;; esac
snapshot=$(realpath -e "$1")
[[ $snapshot == /var/backups/factory-environment/install.* && -f $snapshot/environment ]] || fail 'Invalid snapshot.'
for path in /etc/environment "$snapshot"; do
    while [[ $path != / ]]; do
        [[ ! -L $path ]] || fail "Refusing symlink: $path"
        path=$(dirname "$path")
    done
done
[[ -f /etc/environment && $(stat -c %h /etc/environment) == 1 ]] || fail 'Require a regular, single-link /etc/environment.'
backup=$(mktemp -d /var/backups/factory-environment/rollback.XXXXXX)
cp -p /etc/environment "$backup/environment"
cp -p "$snapshot/environment" /etc/environment
cmp "$snapshot/environment" /etc/environment
echo 'Restored /etc/environment; existing processes and /etc/gitconfig unchanged.'
