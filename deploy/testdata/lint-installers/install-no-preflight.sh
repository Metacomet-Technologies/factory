#!/usr/bin/env bash
# Fixture for deploy/test-lint-installers.py; never run. Fails preflight: nothing is checked before the unit is replaced.
set -Eeuo pipefail
umask 0077
here=$(dirname "$(realpath "$0")")
snapshot=
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run as root.'
trap 'printf "ERROR: failed at line %s. Rollback: sudo bash %q %q\n" "$LINENO" "$here/rollback-good.sh" "$snapshot" >&2' ERR
install -d -m 0700 /var/backups/lint-demo
snapshot=$(mktemp -d /var/backups/lint-demo/XXXXXX)
cp -p /etc/systemd/system/lint-demo.service "$snapshot/" 2>/dev/null || true
install -m 0644 "$here/lint-demo.service" /etc/systemd/system/lint-demo.service
systemctl daemon-reload
systemctl restart lint-demo.service
curl -fsS --max-time 5 http://127.0.0.1:9/health
printf 'Rollback: sudo bash %q %q\n' "$here/rollback-good.sh" "$snapshot"
