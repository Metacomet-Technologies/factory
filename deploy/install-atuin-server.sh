#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
here=$(dirname "$(realpath "$0")")
snapshot=
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run install-atuin-server.sh as root on factory-gpu.'
trap 'printf "ERROR: Atuin install failed at line %s; use rollback-atuin-server.sh %s\n" "$LINENO" "${snapshot:-SNAPSHOT}" >&2' ERR
[[ $# -eq 0 ]] || fail 'Usage: install-atuin-server.sh'
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
[[ $(hostname -s) == factory-gpu && $(uname -m) == x86_64 ]] || fail 'Requires factory-gpu x86_64.'
for tool in curl sha256sum tar systemctl systemd-analyze tailscale getent useradd install cp mktemp dirname cmp; do command -v "$tool" >/dev/null; done
# Never reset Serve: factory-api owns the existing HTTPS :443 handler.
tailscale serve status
[[ $(systemctl show atuin-server.service -p ActiveState --value) == inactive ]] || fail 'Stop Atuin explicitly before replacing its binary/configuration.'
[[ -z $(systemctl show atuin-server.service -p DropInPaths --value) ]] || fail 'Review Atuin drop-ins first.'
if getent passwd atuin >/dev/null; then
    [[ $(getent passwd atuin | cut -d: -f6-7) == /var/lib/atuin:/usr/sbin/nologin ]] || fail 'Unexpected atuin account.'
    [[ $(id -u atuin) -lt 1000 && $(id -u atuin) -ne 0 && $(id -gn atuin) == atuin ]] || fail 'Require a dedicated system account/group.'
fi
for path in /usr/local/bin/atuin-server /etc/atuin/server.toml /var/lib/atuin /var/backups/factory-atuin /etc/systemd/system/atuin-server.service; do
    while [[ $path != / ]]; do
        [[ ! -L $path ]] || fail "Refusing symlink: $path"
        path=$(dirname "$path")
    done
done
for file in /usr/local/bin/atuin-server /etc/atuin/server.toml /etc/systemd/system/atuin-server.service; do
    [[ ! -e $file || -f $file ]] || fail "Not a regular file: $file"
done
[[ -f $here/atuin-server.service && -f $here/atuin-server.toml ]]

# v18.23.0 published 2026-09-22; upstream asset SHA256, not the client binary.
version=18.23.0
sha=ad42a2696e73af09c9e9c5726a268097611299162ddb5c6f1c52c885f0da674c
install -d -m 0700 /var/backups/factory-atuin
snapshot=$(mktemp -d /var/backups/factory-atuin/install.XXXXXX)
for file in /usr/local/bin/atuin-server /etc/atuin/server.toml /etc/systemd/system/atuin-server.service; do
    if [[ -f $file ]]; then cp -p "$file" "$snapshot/$(basename "$file")"; fi
done
: > "$snapshot/complete"
curl --fail --location --retry 3 --connect-timeout 10 --max-time 180 \
    "https://github.com/atuinsh/atuin/releases/download/v$version/atuin-server-x86_64-unknown-linux-gnu.tar.gz" -o "$snapshot/release.tar.gz"
printf '%s  %s\n' "$sha" "$snapshot/release.tar.gz" | sha256sum --check --status
tar --no-same-owner -xzf "$snapshot/release.tar.gz" -C "$snapshot"
binary=$snapshot/atuin-server-x86_64-unknown-linux-gnu/atuin-server
[[ -x $binary ]]
"$binary" --version
if ! getent passwd atuin >/dev/null; then
    useradd --system --user-group --home-dir /var/lib/atuin --shell /usr/sbin/nologin atuin
fi
install -d -o root -g root -m 0755 /etc/atuin
install -o root -g root -m 0644 "$here/atuin-server.toml" /etc/atuin/server.toml
install -o root -g root -m 0755 "$binary" /usr/local/bin/atuin-server
install -o root -g root -m 0644 "$here/atuin-server.service" /etc/systemd/system/atuin-server.service
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/atuin-server.service
cmp "$here/atuin-server.toml" /etc/atuin/server.toml
printf 'Prepared only; no services or Serve handlers changed. Snapshot: %s\n' "$snapshot"
printf '%s\n' 'Next: systemctl enable --now atuin-server.service' \
    'Then: curl --fail --max-time 5 http://127.0.0.1:8888/' \
    'Then: tailscale serve status' \
    'Only if HTTPS :8888 is unused: tailscale serve --bg --https=8888 http://127.0.0.1:8888'
