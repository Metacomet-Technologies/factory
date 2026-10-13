#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
root=
if (( EUID != 0 )); then
    [[ -n ${NUT_TEST_ROOT:-} && -d $NUT_TEST_ROOT && $NUT_TEST_ROOT == /* && $NUT_TEST_ROOT != / ]] || { echo 'ERROR: Run as root.' >&2; exit 1; }
    root=$NUT_TEST_ROOT
fi
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 1 ]] || fail 'Usage: rollback-nut.sh <snapshot>'
snapshot=$1
trap 'printf "ERROR: rollback failed at line %s; snapshot retained. Retry: sudo bash %q %q\n" "$LINENO" "$0" "$snapshot" >&2' ERR
for command in systemctl cp mv mktemp date; do
    command -v "$command" >/dev/null || fail "Required command missing: $command"
done
[[ -d $snapshot && ! -L $snapshot && -f $snapshot/complete ]] || fail 'Incomplete snapshot.'
[[ ( -d $snapshot/nut && ! -L $snapshot/nut && ! -e $snapshot/nut.missing ) || ( -f $snapshot/nut.missing && ! -e $snapshot/nut ) ]] || fail 'Invalid snapshot tree.'
for path in "$root/etc" "$root/etc/nut" "$root/var" "$root/var/backups"; do
    [[ ! -L $path && ( ! -e $path || -d $path ) ]] || fail "Unsafe directory: $path"
done
# Retain the displaced configuration (including credentials) for manual recovery.
recovery=$(mktemp -d "$root/var/backups/nut-pre-rollback-$(date -u +%Y%m%dT%H%M%S.%NZ).XXXXXX")
systemctl stop nut-monitor
systemctl stop nut-server
if [[ -d $root/etc/nut ]]; then mv -- "$root/etc/nut" "$recovery/nut"; fi
if [[ -d $snapshot/nut ]]; then cp -a -- "$snapshot/nut" "$root/etc/nut"; fi
systemctl restart nut-server
systemctl restart nut-monitor
printf 'Snapshot restored. Displaced config retained at: %s\n' "$recovery"
