#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run rollback-atuin-server.sh as root on factory-gpu.'
trap 'printf "ERROR: Atuin rollback failed at line %s; database and account retained.\n" "$LINENO" >&2' ERR
[[ $# -eq 1 ]] || fail 'Usage: rollback-atuin-server.sh SNAPSHOT'
[[ $(hostname -s) == factory-gpu ]] || fail 'factory-gpu only.'
snapshot=$(realpath -e "$1")
[[ $snapshot == /var/backups/factory-atuin/install.* && -d $snapshot ]] || fail 'Invalid snapshot.'
[[ -f $snapshot/complete ]] || fail 'Incomplete snapshot.'
[[ $(systemctl show atuin-server.service -p ActiveState --value) == inactive ]] || fail 'Stop Atuin explicitly before rollback.'
for path in "$snapshot" /usr/local/bin/atuin-server /etc/atuin/server.toml /etc/systemd/system/atuin-server.service; do
    while [[ $path != / ]]; do
        [[ ! -L $path ]] || fail "Refusing symlink: $path"
        path=$(dirname "$path")
    done
done
backup=$(mktemp -d /var/backups/factory-atuin/rollback.XXXXXX)
for file in /usr/local/bin/atuin-server /etc/atuin/server.toml /etc/systemd/system/atuin-server.service; do
    name=$(basename "$file")
    if [[ -f $file ]]; then cp -p "$file" "$backup/$name"; fi
    if [[ -f $snapshot/$name ]]; then
        cp -p "$snapshot/$name" "$file"
        cmp "$snapshot/$name" "$file"
    else
        rm -f "$file"
        [[ ! -e $file ]]
    fi
done
systemctl daemon-reload
echo 'Restored files only; account and /var/lib/atuin retained. No service or Serve handler changed.'
echo 'If activated, first disable the service and remove only its handler: tailscale serve --https=8888 off'
