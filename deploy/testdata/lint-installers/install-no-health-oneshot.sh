#!/usr/bin/env bash
# Fixture for deploy/test-lint-installers.py; never run. Fails health: its oneshot unit sets no TimeoutStartSec, so start may never return.
set -Eeuo pipefail
umask 0077
here=$(dirname "$(realpath "$0")")
snapshot=
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run as root.'
trap 'printf "ERROR: failed at line %s. Rollback: sudo bash %q %q\n" "$LINENO" "$here/rollback-good.sh" "$snapshot" >&2' ERR
[[ $# -eq 0 ]] || fail 'Usage: install-no-health-oneshot.sh'
command -v curl >/dev/null || fail 'curl is missing.'
[[ ! -L /etc/systemd/system/lint-unbounded.service ]] || fail 'Refusing a symlink unit.'
install -d -m 0700 /var/backups/lint-unbounded
snapshot=$(mktemp -d /var/backups/lint-unbounded/XXXXXX)
if [[ -f /etc/systemd/system/lint-unbounded.service ]]; then
    cp -p /etc/systemd/system/lint-unbounded.service "$snapshot/"
else
    touch "$snapshot/lint-unbounded.service.missing"
fi
install -m 0644 "$here/lint-unbounded.service" /etc/systemd/system/lint-unbounded.service
systemctl daemon-reload
systemctl start lint-unbounded.service
printf 'Rollback: sudo bash %q %q\n' "$here/rollback-good.sh" "$snapshot"
