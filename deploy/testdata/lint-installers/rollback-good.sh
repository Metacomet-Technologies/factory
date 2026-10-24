#!/usr/bin/env bash
# Fixture for deploy/test-lint-installers.py; never run. Meets every check.
set -Eeuo pipefail
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run as root.'
[[ $# -eq 1 ]] || fail 'Usage: rollback-good.sh SNAPSHOT'
snapshot=$1
trap 'printf "ERROR: rollback failed at line %s; snapshot retained: %s\n" "$LINENO" "$snapshot" >&2' ERR
[[ -d $snapshot && -f $snapshot/lint-demo.service ]] || fail 'Incomplete snapshot.'
install -m 0644 "$snapshot/lint-demo.service" /etc/systemd/system/lint-demo.service
systemctl daemon-reload
systemctl restart lint-demo.service
curl -fsS --max-time 5 http://127.0.0.1:9/health
