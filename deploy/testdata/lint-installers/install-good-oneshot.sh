#!/usr/bin/env bash
# Fixture for deploy/test-lint-installers.py; never run. Meets every check; its health check is a oneshot unit with TimeoutStartSec.
set -Eeuo pipefail
umask 0077
here=$(dirname "$(realpath "$0")")
snapshot=
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run as root.'
trap 'printf "ERROR: failed at line %s. Rollback: sudo bash %q %q\n" "$LINENO" "$here/rollback-good.sh" "$snapshot" >&2' ERR
[[ $# -eq 0 ]] || fail 'Usage: install-good-oneshot.sh'
command -v curl >/dev/null || fail 'curl is missing.'
[[ ! -L /etc/systemd/system/lint-oneshot.service ]] || fail 'Refusing a symlink unit.'
install -d -m 0700 /var/backups/lint-oneshot
snapshot=$(mktemp -d /var/backups/lint-oneshot/XXXXXX)
if [[ -f /etc/systemd/system/lint-oneshot.service ]]; then
    cp -p /etc/systemd/system/lint-oneshot.service "$snapshot/"
else
    touch "$snapshot/lint-oneshot.service.missing"
fi
install -m 0644 "$here/lint-oneshot.service" /etc/systemd/system/lint-oneshot.service
systemctl daemon-reload
systemctl start lint-oneshot.service
printf 'Rollback: sudo bash %q %q\n' "$here/rollback-good.sh" "$snapshot"
