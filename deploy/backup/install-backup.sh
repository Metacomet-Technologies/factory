#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
here=$(dirname "$(realpath "$0")")
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run as root: sudo bash deploy/backup/install-backup.sh [--prepare-only]'
[[ $# -eq 0 || ( $# -eq 1 && $1 == --prepare-only ) ]] || fail 'Expected --prepare-only or no arguments.'
trap 'printf "ERROR: backup installation failed at line %s. Fix the error and rerun; no automatic rollback.\n" "$LINENO" >&2' ERR
# Ignore development overrides during installation.
unset BACKUP_CONFIG BACKUP_HOST LOCAL_ROOT STATUS_FILE REPLICA_ROOT PEER_REPLICA_ROOT METER_DB REQUESTS_DB PRICING_DB BACKUP_TRANSPORT
# shellcheck source=deploy/backup/nodes.conf
source "$here/nodes.conf"

# Complete preflight before writing deployment files or changing accounts.
for command in sqlite3 zstd sha256sum rsync ssh python3 flock runuser systemctl tailscale \
    useradd usermod getent id install realpath sed stat chmod chown ln dirname hostname \
    bash date mktemp mv rm find sort tail; do
    command -v "$command" >/dev/null || fail "Missing $command; install dependencies first (Ubuntu: apt-get install sqlite3 zstd rsync openssh-client python3)."
done
python3 -c 'import sys; assert sys.version_info >= (3, 11), "Python 3.11+ required"'
[[ -d /run/systemd/system ]] || fail 'systemd is not running.'
systemctl is-active --quiet tailscaled.service
for file in nodes.conf backup-state.py factory-backup.sh restore-check.sh factory-backup.service factory-backup.timer; do
    [[ -f "$here/$file" && -r "$here/$file" ]] || fail "Missing artifact: $file"
done
for entry in "${DBS[@]}"; do
    [[ -f ${entry#*:} ]] || fail "Database missing: ${entry#*:}; deploy its service first."
done
for unit in factory-backup.service factory-backup.timer; do
    [[ -z $(systemctl show "$unit" --property=DropInPaths --value) ]] || fail "Review existing $unit drop-ins first."
    enabled=$(systemctl is-enabled "$unit" 2>/dev/null || true)
    case "$enabled" in enabled|disabled|static|indirect|not-found) ;; *) fail "Unsupported $unit state: $enabled" ;; esac
done
if id backup >/dev/null 2>&1; then
    uid=$(id -u backup)
    (( uid > 0 && uid < 1000 )) || fail 'Existing backup account must be a non-root system user.'
    [[ $(id -Gn backup) == backup ]] || fail 'Existing backup account must have only the backup group (no sudo group).'
else
    ! getent group backup >/dev/null || fail 'backup group exists without its account; resolve first.'
fi
for path in /usr/local/lib/factory-backup /etc/factory-backup /var/lib/factory-backup \
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

if ! id backup >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir "$REPLICA_ROOT" --shell /bin/sh backup
fi
# Tailscale SSH executes remote commands through the account's shell. A locked
# password and no keys/sudo grant no ordinary SSH login; nologin would break rsync.
usermod --lock --home "$REPLICA_ROOT" --shell /bin/sh backup
install -d -o root -g root -m 0755 /usr/local/lib/factory-backup /etc/factory-backup
install -d -o root -g root -m 0700 /var/lib/factory-backup
install -d -o root -g backup -m 0750 "$LOCAL_ROOT" "$LOCAL_ROOT/$BACKUP_HOST"
install -d -o backup -g backup -m 0700 "$REPLICA_ROOT" "$REPLICA_ROOT/.ssh"
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
if [[ ${1:-} == --prepare-only ]]; then
    echo 'Prepared account, directories and units. Prepare the peer, add the MET-73 SSH rule, then rerun without --prepare-only.'
    exit 0
fi
# accept-new records first-use host keys over the trusted tailnet; changed keys
# still fail. Both peer accounts/artifacts must already exist.
runuser -u backup -- ssh -o BatchMode=yes -o ConnectTimeout=30 -o StrictHostKeyChecking=accept-new \
    "backup@$PEER" test -x /usr/local/lib/factory-backup/factory-backup.sh
systemctl start factory-backup.service
/usr/local/lib/factory-backup/restore-check.sh local
systemctl enable --now factory-backup.timer
systemctl list-timers factory-backup.timer --no-pager
echo 'Immediate backup, peer push and local restore-check passed. Timer enabled. Run restore-check.sh all after both nodes complete.'
