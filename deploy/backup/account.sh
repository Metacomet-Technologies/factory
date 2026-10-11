#!/usr/bin/env bash
# Account/ownership migration shared by the installer and its no-root tests.
# The caller supplies node configuration and fail(), and runs this as root.

preflight_backup_account() {
    restore_ubuntu_backup=0
    if id "$BACKUP_USER" >/dev/null 2>&1; then
        local uid
        uid=$(id -u "$BACKUP_USER")
        (( uid > 0 && uid < 1000 && uid != 34 )) || fail "$BACKUP_USER must be a dedicated, non-root system account, not Ubuntu's backup uid 34."
        [[ $(id -Gn "$BACKUP_USER") == "$BACKUP_USER" ]] || fail "$BACKUP_USER must have only its own group (no sudo group)."
    else
        ! getent group "$BACKUP_USER" >/dev/null || fail "$BACKUP_USER group exists without its account; resolve first."
    fi
    local legacy
    legacy=$(getent passwd backup || true)
    if [[ -n "$legacy" ]]; then
        local uid gid home shell
        IFS=: read -r _ _ uid gid _ home shell <<< "$legacy"
        if [[ "$home" == "$REPLICA_ROOT" ]]; then
            [[ "$uid" == 34 && "$gid" == 34 && "$shell" == /bin/sh ]] || fail 'Unexpected legacy backup account; review it manually before migration.'
            restore_ubuntu_backup=1
        fi
    fi
    [[ ! -L "$BACKUP_HOME/known_hosts" && ( ! -e "$BACKUP_HOME/known_hosts" || -f "$BACKUP_HOME/known_hosts" ) ]] || fail 'known_hosts must be a regular file, not a symlink.'
    # These are the only SSH artifacts the previous installer/client created.
    # Do not delete keys or other files an administrator may have added.
    local file
    if [[ -d "$REPLICA_ROOT/.ssh" ]]; then
        for file in "$REPLICA_ROOT/.ssh/"* "$REPLICA_ROOT/.ssh/".[!.]* "$REPLICA_ROOT/.ssh/"..?*; do
            [[ -e "$file" || -L "$file" ]] || continue
            case ${file##*/} in
                known_hosts|known_hosts.old)
                    [[ -f "$file" && ! -L "$file" ]] || fail "Unsafe legacy SSH artifact: $file"
                    ;;
                *) fail "Review unexpected legacy SSH artifact before migration: $file" ;;
            esac
        done
    fi
}

prepare_backup_account() {
    if ! id "$BACKUP_USER" >/dev/null 2>&1; then
        useradd --system --user-group --no-create-home --home-dir "$BACKUP_HOME" --shell /bin/sh "$BACKUP_USER"
    fi
    # Tailscale SSH runs rsync/commands through the login shell; nologin rejects
    # them. No password, keys or sudo privileges are granted to this account.
    usermod --lock --home "$BACKUP_HOME" --shell /bin/sh "$BACKUP_USER"
    install -d -o "$BACKUP_USER" -g "$BACKUP_USER" -m 0700 "$BACKUP_HOME"
    install -d -o root -g root -m 0711 "$(dirname "$REPLICA_ROOT")"
    install -d -o "$BACKUP_USER" -g "$BACKUP_USER" -m 0700 "$REPLICA_ROOT"
    # Preserve every snapshot and its mode. Do not follow links in either tree.
    chown -hR "$BACKUP_USER:$BACKUP_USER" "$REPLICA_ROOT"
    install -d -o root -g "$BACKUP_USER" -m 0750 "$LOCAL_ROOT" "$LOCAL_ROOT/$BACKUP_HOST"
    chgrp -hR "$BACKUP_USER" "$LOCAL_ROOT"
    # All SSH-file writes happen as the unprivileged user, including migration.
    runuser -u "$BACKUP_USER" -- bash -seu -- "$BACKUP_HOME" "$REPLICA_ROOT" <<'SH'
        umask 077
        known=$1/known_hosts
        legacy=$2/.ssh
        : >> "$known"
        if [ -f "$legacy/known_hosts" ]; then
            temporary=$(mktemp "$1/.known-hosts.XXXXXX")
            trap 'rm -f -- "$temporary"' EXIT
            sort -u "$known" "$legacy/known_hosts" > "$temporary"
            mv -- "$temporary" "$known"
        fi
        chmod 0600 "$known"
        rm -f -- "$legacy/known_hosts" "$legacy/known_hosts.old"
        if [ -d "$legacy" ]; then rmdir "$legacy"; fi
SH
    # The old root lock cannot remain in a directory now writable by SSH users.
    # The caller has stopped the backup service; new runs lock in LOCAL_ROOT.
    rm -f -- "$BACKUP_HOME/backup.lock"
    if (( restore_ubuntu_backup )); then
        usermod --home /var/backups --shell /usr/sbin/nologin --password '*' backup
    fi
}
