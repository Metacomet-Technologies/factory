#!/usr/bin/env bash
# Fixture for deploy/test-lint-installers.py; never run.
# Fails snapshot: it replaces the unit without validating or taking a snapshot.
set -Eeuo pipefail
here=$(dirname "$(realpath "$0")")
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run as root.'
trap 'printf "ERROR: rollback failed at line %s\n" "$LINENO" >&2' ERR
command -v systemctl >/dev/null || fail 'systemctl is missing.'
install -m 0644 "$here/lint-demo.service" /etc/systemd/system/lint-demo.service
systemctl daemon-reload
systemctl restart lint-demo.service
curl -fsS --max-time 5 http://127.0.0.1:9/health
