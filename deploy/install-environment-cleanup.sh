#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
here=$(dirname "$(realpath "$0")")
snapshot=
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run install-environment-cleanup.sh as root.'
trap 'printf "ERROR: environment cleanup failed at line %s; use rollback-environment-cleanup.sh %s\n" "$LINENO" "${snapshot:-SNAPSHOT}" >&2' ERR
[[ $# -eq 0 ]] || fail 'Usage: install-environment-cleanup.sh'
case $(hostname -s) in factory-gpu|factory-console) ;; *) fail 'Factory nodes only.' ;; esac
for tool in systemctl python3 cp mktemp dirname cmp; do command -v "$tool" >/dev/null; done
systemctl is-active --quiet amp-runner.service
pid=$(systemctl show amp-runner.service -p MainPID --value)
[[ $pid =~ ^[1-9][0-9]*$ ]] || fail 'amp-runner has no live MainPID.'
# Read the live process, not the unit settings, login shell or /etc/environment.
python3 - "$pid" <<'PY'
from pathlib import Path
import sys
values = Path(f'/proc/{int(sys.argv[1])}/environ').read_bytes().split(b'\0')
if b'NO_COLOR=1' not in values:
    sys.exit('Refusing cleanup: live amp-runner environment must contain NO_COLOR=1')
PY
[[ $(systemctl show amp-runner.service -p MainPID --value) == "$pid" ]] || fail 'amp-runner changed during preflight; rerun.'
for path in /etc/environment /var/backups/factory-environment; do
    while [[ $path != / ]]; do
        [[ ! -L $path ]] || fail "Refusing symlink: $path"
        path=$(dirname "$path")
    done
done
[[ -f /etc/environment && $(stat -c %h /etc/environment) == 1 ]] || fail 'Require a regular, single-link /etc/environment.'
install -d -m 0700 /var/backups/factory-environment
snapshot=$(mktemp -d /var/backups/factory-environment/install.XXXXXX)
cp -p /etc/environment "$snapshot/environment"
cp -p /etc/environment "$snapshot/clean"
python3 "$here/clean-environment.py" < "$snapshot/environment" > "$snapshot/clean"
cp -p "$snapshot/clean" /etc/environment
cmp "$snapshot/clean" /etc/environment
printf 'Cleaned /etc/environment; existing processes and /etc/gitconfig unchanged. Snapshot: %s\n' "$snapshot"
