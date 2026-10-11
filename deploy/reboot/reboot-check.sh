#!/usr/bin/env bash
set -Eeuo pipefail
here=$(dirname "$(realpath "$0")")
exec python3 "$here/reboot-policy.py" check "$@"
