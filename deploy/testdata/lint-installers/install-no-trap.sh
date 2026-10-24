#!/usr/bin/env bash
# Fixture for deploy/test-lint-installers.py; never run. Fails trap: the only trap is an EXIT cleanup that prints nothing.
set -Eeuo pipefail
umask 0077
here=$(dirname "$(realpath "$0")")
snapshot=
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run as root.'
staging=$(mktemp -d)
trap 'rm -rf -- "$staging"' EXIT
[[ $# -eq 0 ]] || fail 'Usage: install-no-trap.sh'
command -v curl >/dev/null || fail 'curl is missing.'
[[ ! -L /etc/systemd/system/lint-demo.service ]] || fail 'Refusing a symlink unit.'
install -d -m 0700 /var/backups/lint-demo
snapshot=$(mktemp -d /var/backups/lint-demo/XXXXXX)
if [[ -f /etc/systemd/system/lint-demo.service ]]; then
    cp -p /etc/systemd/system/lint-demo.service "$snapshot/"
else
    touch "$snapshot/lint-demo.service.missing"
fi
install -m 0644 "$here/lint-demo.service" /etc/systemd/system/lint-demo.service
systemctl daemon-reload
systemctl restart lint-demo.service
curl -fsS --max-time 5 http://127.0.0.1:9/health
printf 'Rollback: sudo bash %q %q\n' "$here/rollback-good.sh" "$snapshot"
