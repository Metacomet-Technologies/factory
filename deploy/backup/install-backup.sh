#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
here=$(dirname "$(realpath "$0")")
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run as root: sudo bash deploy/backup/install-backup.sh [--prepare-only]'
[[ $# -eq 0 || ( $# -eq 1 && $1 == --prepare-only ) ]] || fail 'Expected --prepare-only or no arguments.'
trap 'printf "ERROR: backup installation failed at line %s. Fix the error and rerun; no automatic rollback.\n" "$LINENO" >&2' ERR
# Ignore development overrides during installation.
unset BACKUP_CONFIG BACKUP_HOST BACKUP_HOME LOCAL_ROOT STATUS_FILE REPLICA_ROOT PEER_REPLICA_ROOT METER_DB REQUESTS_DB PRICING_DB UPS_CONTROL_DB BACKUP_TRANSPORT
# shellcheck source=deploy/backup/nodes.conf
source "$here/nodes.conf"
# shellcheck source=deploy/backup/account.sh
source "$here/account.sh"

# Complete preflight before writing deployment files or changing accounts.
for command in sqlite3 zstd sha256sum rsync ssh python3 flock runuser systemctl tailscale \
    useradd usermod getent id install realpath sed stat chmod chown ln dirname hostname \
    bash date mktemp mv rm rmdir find sort tail chgrp cp mkdir touch; do
    command -v "$command" >/dev/null || fail "Missing $command; install dependencies first (Ubuntu: apt-get install sqlite3 zstd rsync openssh-client python3)."
done
python3 -c 'import sys; assert sys.version_info >= (3, 11), "Python 3.11+ required"'
[[ -d /run/systemd/system ]] || fail 'systemd is not running.'
systemctl is-active --quiet tailscaled.service
for file in account.sh nodes.conf backup-state.py factory-backup.sh restore-check.sh factory-backup.service factory-backup.timer rollback-backup-config.sh; do
    [[ -f "$here/$file" && -r "$here/$file" ]] || fail "Missing artifact: $file"
done
for entry in "${DBS[@]}"; do
    [[ -f ${entry#*:} ]] || fail "Database missing: ${entry#*:}; deploy its service first."
done
for unit in factory-backup.service factory-backup.timer; do
    [[ -z $(systemctl show "$unit" --property=DropInPaths --value) ]] || fail "Review existing $unit drop-ins first."
    enabled=$(systemctl is-enabled "$unit" 2>/dev/null || true)
    case "$enabled" in enabled|disabled|static|indirect|not-found) ;; *) fail "Unsupported $unit state: $enabled" ;; esac
    active=$(systemctl is-active "$unit" 2>/dev/null || true)
    case "$active" in active|inactive|unknown) ;; *) fail "Resolve failed/transitional $unit before installing." ;; esac
done
for path in /usr/local/lib/factory-backup /etc/factory-backup "$BACKUP_HOME" \
    "$LOCAL_ROOT" "$LOCAL_ROOT/$BACKUP_HOST" "$REPLICA_ROOT" "$REPLICA_ROOT/.ssh" \
    /etc/systemd/system/factory-backup.service /etc/systemd/system/factory-backup.timer \
    /etc/factory-backup/nodes.conf /usr/local/lib/factory-backup/backup-state.py \
    /usr/local/lib/factory-backup/factory-backup.sh /usr/local/lib/factory-backup/restore-check.sh; do
    parent=$path
    while [[ "$parent" != / ]]; do
        [[ ! -L "$parent" ]] || fail "Refusing symlink destination: $parent"
        parent=$(dirname "$parent")
    done
done
preflight_backup_account

# Configuration-only rollback: accounts, archive trees, trust files and live DBs
# are deliberately outside this snapshot and must never be deleted on rollback.
bash "$here/rollback-backup-config.sh" --snapshot
if [[ $(systemctl show factory-backup.timer --property=LoadState --value) != not-found ]]; then
    systemctl disable --now factory-backup.timer
fi
if [[ $(systemctl show factory-backup.service --property=LoadState --value) != not-found ]]; then
    systemctl stop factory-backup.service
fi
prepare_backup_account
install -d -o root -g root -m 0755 /usr/local/lib/factory-backup /etc/factory-backup
for file in factory-backup.sh restore-check.sh; do
    install -o root -g root -m 0755 "$here/$file" "/usr/local/lib/factory-backup/$file"
done
install -o root -g root -m 0644 "$here/backup-state.py" /usr/local/lib/factory-backup/backup-state.py
# Keep a single root-owned configuration; the installed scripts source its link.
install -o root -g root -m 0644 "$here/nodes.conf" /etc/factory-backup/nodes.conf
ln -sfn /etc/factory-backup/nodes.conf /usr/local/lib/factory-backup/nodes.conf
install -o root -g root -m 0644 "$here/factory-backup.service" /etc/systemd/system/factory-backup.service
sed "s/03:15:00/$BACKUP_TIME/" "$here/factory-backup.timer" > /etc/systemd/system/factory-backup.timer
chmod 0644 /etc/systemd/system/factory-backup.timer
systemctl daemon-reload
runuser -u "$BACKUP_USER" -- /usr/local/lib/factory-backup/factory-backup.sh --check-access
if [[ ${1:-} == --prepare-only ]]; then
    echo 'Prepared factory-backup, migrated ownership and verified filesystem access. Timer is disabled. Prepare the peer and permit factory-backup in MET-73, then rerun without --prepare-only.'
    exit 0
fi
# accept-new records first-use host keys over the trusted tailnet; changed keys
# still fail. Both peer accounts/artifacts must already exist.
runuser -u "$BACKUP_USER" -- ssh "${SSH_OPTIONS[@]}" \
    "$BACKUP_USER@$PEER" test -x /usr/local/lib/factory-backup/factory-backup.sh
systemctl start factory-backup.service
/usr/local/lib/factory-backup/restore-check.sh local
systemctl enable --now factory-backup.timer
systemctl list-timers factory-backup.timer --no-pager
echo 'Immediate backup, peer push and local restore-check passed. Timer enabled. Run restore-check.sh all after both nodes complete.'
