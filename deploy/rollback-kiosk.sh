#!/usr/bin/env bash
set -Eeuo pipefail
destination=/var/lib/factory-api/kiosk
snapshot=${1:-}
stage=
response=
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run as root: bash deploy/rollback-kiosk.sh [snapshot-directory].'
[[ $# -le 1 ]] || fail 'Expected at most one snapshot directory (default: latest complete snapshot).'
trap 'printf "ERROR: kiosk rollback failed at line %s. Snapshot retained: %s.\n" "$LINENO" "$snapshot" >&2' ERR
trap '[[ -z "$stage" ]] || rm -rf -- "$stage"; [[ -z "$response" ]] || rm -f -- "$response"' EXIT
for command in curl cmp getent realpath find cp chown chmod mktemp mv rm sort flock grep; do
    command -v "$command" >/dev/null || fail "Required command missing: $command"
done
mv_help=$(mv --help)
[[ "$mv_help" == *--exchange* && "$mv_help" == *--no-copy* ]] || fail 'GNU mv with --exchange and --no-copy is required.'
getent group factory-api >/dev/null
[[ -d /var/lib/factory-api && ! -L /var/lib/factory-api ]] || fail 'Unsafe or missing factory-api state directory.'
[[ -d /var/backups/factory-kiosk && ! -L /var/backups/factory-kiosk ]] || fail 'No kiosk snapshots found.'
exec 9>/var/backups/factory-kiosk/.lock
flock -n 9 || fail 'Another kiosk install or rollback is running.'
if [[ -z "$snapshot" ]]; then
    snapshots=$(find /var/backups/factory-kiosk -mindepth 2 -maxdepth 2 -type f -name complete -printf '%h\n' | sort -r)
    [[ -n "$snapshots" ]] || fail 'No complete kiosk snapshots found.'
    snapshot=${snapshots%%$'\n'*}
fi
[[ ! -L "$snapshot" ]] || fail 'Refusing a symlink snapshot directory.'
snapshot=$(realpath "$snapshot")
[[ -f "$snapshot/complete" && ! -L "$snapshot" ]] || fail 'Snapshot is incomplete.'
[[ ! -L "$destination" && ( ! -e "$destination" || -d "$destination" ) ]] || fail 'Unsafe kiosk destination.'
curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:8080/v1/health
if [[ -d "$snapshot/kiosk" && ! -L "$snapshot/kiosk" && ! -e "$snapshot/kiosk.missing" ]]; then
    entries=$(find "$snapshot/kiosk" ! -type d ! -type f -print -quit)
    [[ -z "$entries" ]] || fail 'Snapshot contains non-regular entries.'
    stage=$(mktemp -d /var/lib/factory-api/.kiosk-rollback.XXXXXX)
    cp -a -- "$snapshot/kiosk/." "$stage/"
    chown -R root:factory-api "$stage"
    find "$stage" -type d -exec chmod 0550 {} +
    find "$stage" -type f -exec chmod 0440 {} +
    if [[ -d "$destination" ]]; then
        mv --exchange --no-copy -T -- "$stage" "$destination"
    else
        mv --no-copy -T -- "$stage" "$destination"
        stage=
    fi
elif [[ -f "$snapshot/kiosk.missing" && ! -e "$snapshot/kiosk" ]]; then
    if [[ -d "$destination" ]]; then
        stage=$(mktemp -d /var/lib/factory-api/.kiosk-rollback.XXXXXX)
        mv --exchange --no-copy -T -- "$stage" "$destination"
        # The empty directory serves the same placeholder as the previous absence.
        rm -d -- "$destination"
    fi
else
    fail 'Invalid kiosk snapshot entries.'
fi
response=$(mktemp)
curl -fsS --max-time 10 -H 'Accept: text/html' -o "$response" http://127.0.0.1:8080/
if [[ -f "$destination/index.html" ]]; then
    cmp -s -- "$destination/index.html" "$response" || fail 'GET / does not match the restored index.html.'
else
    grep -Fq 'factory · kiosk not deployed yet' "$response" || fail 'GET / does not show the placeholder.'
fi
printf 'Kiosk snapshot restored: %s. GET / verified; no service restart.\n' "$snapshot"
