#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run rollback-agent-env.sh as root.'
trap 'printf "ERROR: agent-env rollback failed at line %s; no service was restarted.\n" "$LINENO" >&2' ERR
[[ $# -eq 1 ]] || fail 'Usage: rollback-agent-env.sh SNAPSHOT'
case $(hostname -s) in factory-gpu|factory-console) ;; *) fail 'Factory nodes only.' ;; esac
snapshot=$(realpath -e "$1")
[[ $snapshot == /var/backups/factory-agent-env/install.* && -d $snapshot ]] || fail 'Invalid snapshot.'
[[ -f $snapshot/agent-env.conf || -f $snapshot/missing ]] || fail 'Incomplete snapshot.'
target=/etc/systemd/system/amp-runner.service.d/agent-env.conf
for path in "$target" "$snapshot"; do
    while [[ $path != / ]]; do
        [[ ! -L $path ]] || fail "Refusing symlink: $path"
        path=$(dirname "$path")
    done
done
# Preserve any subsequent operator edits before restoring the selected snapshot.
backup=$(mktemp -d /var/backups/factory-agent-env/rollback.XXXXXX)
if [[ -f $target ]]; then cp -p "$target" "$backup/agent-env.conf"; fi
if [[ -f $snapshot/missing ]]; then
    rm -f "$target"
    [[ ! -e $target ]]
else
    cp -p "$snapshot/agent-env.conf" "$target"
    cmp "$snapshot/agent-env.conf" "$target"
fi
systemctl daemon-reload
echo 'Restored drop-in only. Restart explicitly when ready: systemctl restart amp-runner.service'
