#!/usr/bin/env bash
set -Eeuo pipefail
source_dir=${1:-/home/agent/work/factory/kiosk/dist}
destination=/var/lib/factory-api/kiosk
snapshot=
stage=
response=
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run as root: bash deploy/install-kiosk.sh [built-dist-directory].'
[[ $# -le 1 ]] || fail 'Expected at most one built dist directory.'
trap 'printf "ERROR: kiosk install failed at line %s. Snapshot: %s. Recover with: bash deploy/rollback-kiosk.sh <snapshot>\n" "$LINENO" "${snapshot:-not created (kiosk unchanged)}" >&2' ERR
trap '[[ -z "$stage" ]] || rm -rf -- "$stage"; [[ -z "$response" ]] || rm -f -- "$response"' EXIT

# Preflight is read-only. Never build, change service state, or accept symlink trees.
for command in curl cmp getent id realpath find install cp chown chmod mktemp mv rm touch date flock; do
    command -v "$command" >/dev/null || fail "Required command missing: $command"
done
mv_help=$(mv --help)
[[ "$mv_help" == *--exchange* && "$mv_help" == *--no-copy* ]] || fail 'GNU mv with --exchange and --no-copy is required.'
id factory-api >/dev/null
[[ $(id -u factory-api) -ne 0 ]] || fail 'factory-api must not be a root account.'
getent group factory-api >/dev/null
[[ -d /var/lib/factory-api && ! -L /var/lib/factory-api ]] || fail 'factory-api state directory is missing or is a symlink.'
[[ -d "$source_dir" && ! -L "$source_dir" && -f "$source_dir/index.html" ]] || fail "Built kiosk index.html missing: $source_dir"
source_dir=$(realpath "$source_dir")
[[ "$source_dir" != "$destination" && "$source_dir" != "$destination/"* && "$destination" != "$source_dir/"* ]] || fail 'Use a separate built dist directory, not an ancestor of the destination.'
entries=$(find "$source_dir" ! -type d ! -type f -print -quit)
[[ -z "$entries" ]] || fail 'Dist must contain only regular files and directories (no symlinks).'
[[ ! -L "$destination" && ( ! -e "$destination" || -d "$destination" ) ]] || fail 'Unsafe kiosk destination.'
[[ ! -L /var/backups/factory-kiosk && ( ! -e /var/backups/factory-kiosk || -d /var/backups/factory-kiosk ) ]] || fail 'Unsafe kiosk backup directory.'
curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:8080/v1/health

# Serialize install/rollback; each snapshot records the complete previous tree or absence.
install -d -m 0700 /var/backups/factory-kiosk
exec 9>/var/backups/factory-kiosk/.lock
flock -n 9 || fail 'Another kiosk install or rollback is running.'
snapshot=$(mktemp -d "/var/backups/factory-kiosk/$(date -u +%Y%m%dT%H%M%S.%NZ).XXXXXX")
if [[ -d "$destination" ]]; then
    entries=$(find "$destination" ! -type d ! -type f -print -quit)
    [[ -z "$entries" ]] || fail 'Existing kiosk contains non-regular entries; review before replacing.'
    cp -a -- "$destination" "$snapshot/kiosk"
else
    touch "$snapshot/kiosk.missing"
fi
touch "$snapshot/complete"
printf 'Rollback snapshot: %s\n' "$snapshot"

stage=$(mktemp -d /var/lib/factory-api/.kiosk-install.XXXXXX)
cp -a -- "$source_dir/." "$stage/"
chown -R root:factory-api "$stage"
find "$stage" -type d -exec chmod 0550 {} +
find "$stage" -type f -exec chmod 0440 {} +
if [[ -d "$destination" ]]; then
    mv --exchange --no-copy -T -- "$stage" "$destination"
else
    mv --no-copy -T -- "$stage" "$destination"
    stage=
fi
response=$(mktemp)
curl -fsS --max-time 10 -H 'Accept: text/html' -o "$response" http://127.0.0.1:8080/
cmp -s -- "$destination/index.html" "$response" || fail "GET / does not match the installed index.html. Restore with: bash deploy/rollback-kiosk.sh $snapshot"
printf 'Kiosk installed and GET / verified. No service restart.\n'
