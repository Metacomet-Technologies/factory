#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
here=$(dirname "$(realpath "$0")")
# shellcheck source=deploy/ups/control-state.sh
source "$here/control-state.sh"
[[ $# -eq 3 || ( $# -eq 4 && ( $4 == --dry-run || $4 == --preflight ) ) ]] || fail 'Usage: install-ups-control.sh PREBUILT_BINARY TRUSTED_PEER_UID ALLOWED_LOGINS_CSV [--dry-run|--preflight]'
binary=$(realpath "$1")
[[ -f $binary && -x $binary ]] || fail 'Prebuilt executable required.'
[[ $2 =~ ^(0|[1-9][0-9]{0,9})$ && $2 -lt 4294967295 && $3 =~ ^[A-Za-z0-9][A-Za-z0-9@._+-]*(,[A-Za-z0-9][A-Za-z0-9@._+-]*)*$ ]] || fail 'Invalid trusted UID or login CSV.'
for command in systemctl timedatectl hostname getent useradd install cp cmp mktemp curl python3 runuser id stat sed cut chmod chown; do
    command -v "$command" >/dev/null || fail "Missing command: $command"
done
[[ -n $root || -d /run/systemd/system ]] || fail 'systemd required.'
[[ -n $root || $(hostname -s) == factory-gpu ]] || fail 'Install only on factory-gpu.'
[[ $(timedatectl show --property=Timezone --value) == America/New_York ]] || fail 'Review timezone first: 11:00 local must not overlap the 06:00 America/New_York reboot window.'
for path in "${files[@]}" var/lib/factory-ups-control var/lib/factory-ups-control/audit.db var/backups etc/nut/factory-control.password etc/factory-alerts/slack-token; do
    safe "$root/$path"
done
for path in "${files[@]}" var/lib/factory-ups-control/audit.db; do
    [[ ! -e $root/$path || -f $root/$path ]] || fail "Regular file required: /$path"
done
for path in var/lib/factory-ups-control var/backups; do
    [[ ! -e $root/$path || -d $root/$path ]] || fail "Directory required: /$path"
done
for path in etc/nut/factory-control.password etc/factory-alerts/slack-token; do
    [[ -s $root/$path && -f $root/$path && $(stat -c %a "$root/$path") == 600 ]] || fail "Root-only 0600 credential required: /$path"
    [[ -n $root || $(stat -c %u "$root/$path") == 0 ]] || fail "Root credential owner required: /$path"
done
if getent passwd factory-ups-control >/dev/null; then
    account=$(getent passwd factory-ups-control)
    [[ $(cut -d: -f6 <<< "$account") == /var/lib/factory-ups-control && $(cut -d: -f7 <<< "$account") == /usr/sbin/nologin ]] || fail 'Review existing factory-ups-control account.'
    uid=$(cut -d: -f3 <<< "$account")
    [[ $uid =~ ^[0-9]+$ && $uid -gt 0 && $uid -lt 1000 && $uid != "$2" ]] || fail 'Dedicated system UID required, distinct from trusted peer UID.'
fi
check_states
if [[ -n ${4:-} ]]; then
    echo 'Read-only preflight passed. Credentials: nut-password=<masked>, slack-bot-token=<masked>.'
    echo 'Daemon startup initializes/migrates audit.db; existing DB receives a verified SQLite snapshot first. No scheduled test is run.'
    echo 'Manual routing only: tailscale serve --bg --https=443 --set-path /control http://127.0.0.1:8090'
    exit 0
fi
snapshot=
trap 'echo "Installation failed; retained snapshot: $snapshot" >&2; echo "Recover: bash $here/rollback-ups-control.sh $snapshot" >&2' ERR
snapshot_files
# Quiesce both writers before the backup and any daemon-owned migration.
stop_units
if [[ -f $root/var/lib/factory-ups-control/audit.db ]]; then
    python3 - "$root/var/lib/factory-ups-control/audit.db" "$snapshot/audit.db" <<'PY'
import pathlib, sqlite3, sys
with sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri() + '?mode=ro', uri=True) as source:
    with sqlite3.connect(sys.argv[2]) as target:
        source.backup(target)
        assert target.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
        for (name,) in source.execute("SELECT name FROM sqlite_schema WHERE type='table'"):
            quoted = '"' + name.replace('"', '""') + '"'
            assert source.execute(f'SELECT count(*) FROM {quoted}').fetchone() == target.execute(f'SELECT count(*) FROM {quoted}').fetchone()
PY
fi
if ! getent passwd factory-ups-control >/dev/null; then
    useradd --system --user-group --no-create-home --home-dir /var/lib/factory-ups-control --shell /usr/sbin/nologin factory-ups-control
fi
[[ $(id -u factory-ups-control) != "$2" ]] || fail "Trusted peer UID must differ from service UID; rollback: $snapshot"
install -d -o factory-ups-control -g factory-ups-control -m 0700 "$root/var/lib/factory-ups-control"
install -d -m 0755 "$root/usr/local/bin" "$root/etc/systemd/system"
if ! cmp -s "$binary" "$root/usr/local/bin/factory-ups-control"; then
    install -o root -g root -m 0755 "$binary" "$root/usr/local/bin/factory-ups-control"
fi
chown root:root "$root/usr/local/bin/factory-ups-control"
chmod 0755 "$root/usr/local/bin/factory-ups-control"
sed -e "s/@UID@/$2/" -e "s/@LOGINS@/$3/" "$here/factory-ups-control.service.in" > "$snapshot/rendered.service"
if ! cmp -s "$snapshot/rendered.service" "$root/etc/systemd/system/factory-ups-control.service"; then
    install -o root -g root -m 0644 "$snapshot/rendered.service" "$root/etc/systemd/system/factory-ups-control.service"
fi
for unit in factory-ups-selftest.service factory-ups-selftest.timer; do
    if ! cmp -s "$here/$unit" "$root/etc/systemd/system/$unit"; then
        install -o root -g root -m 0644 "$here/$unit" "$root/etc/systemd/system/$unit"
    fi
done
for unit in "${units[@]}"; do
    chown root:root "$root/etc/systemd/system/$unit"
    chmod 0644 "$root/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable --now factory-ups-control.service
# No health bypass: an untrusted local socket with forged identity must be denied.
code=$(runuser -u factory-ups-control -- curl --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 --max-time 5 --noproxy '*' -o /dev/null -w '%{http_code}' -H "Tailscale-User-Login: ${3%%,*}" http://127.0.0.1:8090/control)
[[ $code == 403 ]] || fail "Forged local identity was not rejected (HTTP $code); rollback required: $snapshot"
systemctl is-active --quiet factory-ups-control.service
systemctl enable --now factory-ups-selftest.timer
echo "Recover: bash $here/rollback-ups-control.sh $snapshot"
echo 'Manual routing only (not executed): tailscale serve --bg --https=443 --set-path /control http://127.0.0.1:8090'
