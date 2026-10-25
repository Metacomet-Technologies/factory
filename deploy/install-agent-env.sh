#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
here=$(dirname "$(realpath "$0")")
snapshot=
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run install-agent-env.sh as root.'
trap 'printf "ERROR: agent-env install failed at line %s; snapshot: %s; use rollback-agent-env.sh SNAPSHOT\n" "$LINENO" "${snapshot:-none}" >&2' ERR
[[ $# -eq 0 ]] || fail 'Usage: install-agent-env.sh'
case $(hostname -s) in factory-gpu|factory-console) ;; *) fail 'Factory nodes only.' ;; esac
for tool in systemctl install cp mktemp cmp dirname; do command -v "$tool" >/dev/null; done
[[ $(systemctl show amp-runner.service -p LoadState --value) == loaded ]] || fail 'amp-runner must be installed.'
target=/etc/systemd/system/amp-runner.service.d/agent-env.conf
for path in "$target" /var/backups/factory-agent-env; do
    while [[ $path != / ]]; do
        [[ ! -L $path ]] || fail "Refusing symlink: $path"
        path=$(dirname "$path")
    done
done
[[ ! -e $target || -f $target ]] || fail 'Drop-in must be a regular file.'
[[ -f $here/amp-runner-agent-env.conf ]]
install -d -m 0700 /var/backups/factory-agent-env
snapshot=$(mktemp -d /var/backups/factory-agent-env/install.XXXXXX)
if [[ -f $target ]]; then cp -p "$target" "$snapshot/agent-env.conf"; else : > "$snapshot/missing"; fi
install -d -m 0755 /etc/systemd/system/amp-runner.service.d
install -o root -g root -m 0644 "$here/amp-runner-agent-env.conf" "$target"
systemctl daemon-reload
cmp "$here/amp-runner-agent-env.conf" "$target"
printf 'Prepared only. Snapshot: %s\n' "$snapshot"
printf '%s\n' \
    'Follow up explicitly, in order:' \
    '1. systemctl restart amp-runner.service' \
    "2. pid=\$(systemctl show amp-runner.service -p MainPID --value); tr '\\0' '\\n' < \"/proc/\$pid/environ\" | grep -Fx 'NO_COLOR=1'" \
    '3. rm /etc/factory/agent.env'
