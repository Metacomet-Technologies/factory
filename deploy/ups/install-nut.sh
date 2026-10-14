#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
here=$(dirname "$(realpath "$0")")
root=
# Test overrides are available only to unprivileged fake-root tests, never sudo.
if (( EUID != 0 )); then
    [[ -n ${NUT_TEST_ROOT:-} && -d $NUT_TEST_ROOT && $NUT_TEST_ROOT == /* && $NUT_TEST_ROOT != / ]] || { echo 'ERROR: Run as root.' >&2; exit 1; }
    root=$NUT_TEST_ROOT
fi
snapshot=
staging=
rollback_hint() {
    if [[ -n $snapshot ]]; then
        printf 'Recover with: sudo bash %q %q\n' "$here/rollback-nut.sh" "$snapshot" >&2
    else
        echo 'No deployment changes made; no complete snapshot exists.' >&2
    fi
}
fail() { printf 'ERROR: %s\n' "$*" >&2; rollback_hint; exit 1; }
trap 'printf "ERROR: NUT install failed at line %s.\n" "$LINENO" >&2; rollback_hint' ERR
trap '[[ -z $staging ]] || rm -rf -- "$staging"' EXIT
[[ $# -eq 0 || ( $# -eq 1 && $1 == --dry-run ) ]] || fail 'Usage: install-nut.sh [--dry-run]'
for command in python3 realpath; do
    command -v "$command" >/dev/null || fail "Required command missing: $command"
done
for path in "$root/etc" "$root/etc/nut" "$root/var" "$root/var/backups"; do
    [[ ! -L $path && ( ! -e $path || -d $path ) ]] || fail "Unsafe directory: $path"
done
names=(nut.conf ups.conf upsd.conf upsd.users upsmon.conf)
for name in "${names[@]}"; do
    [[ -r $here/$name.in ]] || fail "Template missing: $name.in"
    path=$root/etc/nut/$name
    [[ ! -L $path && ( ! -e $path || -f $path ) ]] || fail "Unsafe config: $path"
done
path=$root/etc/nut/factory-control.password
[[ ! -L $path && ( ! -e $path || -f $path ) ]] || fail "Unsafe credential: $path"
if [[ ${1:-} == --dry-run ]]; then
    python3 "$here/render.py" "$root/etc/nut" --dry-run
    echo 'Read-only, normalized config diff complete; passwords masked. No changes made.'
    exit 0
fi
for command in apt-get dpkg-query systemctl journalctl udevadm openssl getent groupadd install cp cmp mktemp date touch rm sleep mkdir chown chmod runuser; do
    command -v "$command" >/dev/null || fail "Required command missing: $command"
done
[[ -n $root || -d /run/systemd/system ]] || fail 'systemd is not running.'
installed=false
if [[ $(dpkg-query -W -f='${Status}' nut 2>/dev/null || true) == 'install ok installed' ]]; then
    installed=true
    command -v upsc >/dev/null || fail 'Installed NUT is missing upsc.'
fi
# Render in a private temporary directory; failure here changes no deployment files.
staging=$(mktemp -d)
python3 "$here/render.py" "$root/etc/nut" "$staging"
changed=false
for name in "${names[@]}"; do
    if ! cmp -s "$staging/$name" "$root/etc/nut/$name"; then changed=true; fi
done
mkdir -p "$root/var/backups"
candidate=$(mktemp -d "$root/var/backups/nut-$(date -u +%Y%m%dT%H%M%S.%NZ).XXXXXX")
if [[ -d $root/etc/nut ]]; then
    cp -a -- "$root/etc/nut" "$candidate/nut"
else
    touch "$candidate/nut.missing"
fi
touch "$candidate/complete"
snapshot=$candidate
printf 'Rollback snapshot: %s\n' "$snapshot"
if ! getent group nut >/dev/null; then groupadd --system nut; fi
if [[ ! -d $root/etc/nut ]]; then install -d -m 0750 "$root/etc/nut"; fi
for name in "${names[@]}"; do
    # Avoid changing file timestamps on a byte-identical rerun.
    if ! cmp -s "$staging/$name" "$root/etc/nut/$name"; then
        install -o root -g nut -m 0640 "$staging/$name" "$root/etc/nut/$name"
    else
        chown root:nut "$root/etc/nut/$name"
        chmod 0640 "$root/etc/nut/$name"
    fi
done
if ! cmp -s "$staging/factory-control.password" "$root/etc/nut/factory-control.password"; then
    install -o root -g root -m 0600 "$staging/factory-control.password" "$root/etc/nut/factory-control.password"
else
    chown root:root "$root/etc/nut/factory-control.password"
    chmod 0600 "$root/etc/nut/factory-control.password"
fi
if [[ $installed == false ]]; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
        -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold nut
fi
udevadm control --reload-rules
udevadm trigger --subsystem-match=usb --attr-match=idVendor=0764 --action=add
udevadm settle
since=$(date --iso-8601=seconds)
if [[ $changed == true ]]; then
    systemctl restart nut-server
    systemctl restart nut-monitor
else
    echo 'Config unchanged; nut-server and nut-monitor not restarted.'
fi
# Poll quietly, then perform the visible status check once.
upsc_command=(upsc)
if [[ -z $root ]]; then upsc_command=(runuser -u nut -- upsc); fi
deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
    status=$("${upsc_command[@]}" cyberpower@localhost ups.status 2>/dev/null || true)
    if [[ $status == OL || $status == 'OL '* || $status == OB || $status == 'OB '* ]]; then break; fi
    sleep 1
done
status=$("${upsc_command[@]}" cyberpower@localhost ups.status)
[[ $status == OL || $status == 'OL '* || $status == OB || $status == 'OB '* ]] || fail 'UPS status is neither OL nor OB.'
printf 'UPS status: %s\n' "$status"
args=(-u nut-server --no-pager -o cat)
if [[ $changed == true ]]; then args+=(--since "$since"); else args+=(-b); fi
deadline=$((SECONDS + 45))
while :; do
    journal=$(journalctl "${args[@]}")
    [[ $journal != *'upsmon@127.0.0.1 logged into UPS'* ]] || break
    (( SECONDS < deadline )) || fail 'nut-server journal lacks the local upsmon login.'
    sleep 1
done
echo 'NUT status and local upsmon login verified.'
