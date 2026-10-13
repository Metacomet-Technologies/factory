#!/usr/bin/env bash
# MET-150 rollback: remove what install-alerts.sh added on this node.
#   factory-gpu:     drop-in first (restart factory-api without it), then the token.
#   factory-console: watchdog timer/service/script and its state, then the token.
# factory-api's /var/lib/factory-api/alerts.json is left in place; without the
# token the engine only evaluates and logs.
set -Eeuo pipefail
umask 0077
root=
if (( EUID != 0 )); then
    [[ -n ${ALERTS_TEST_ROOT:-} && -d $ALERTS_TEST_ROOT && $ALERTS_TEST_ROOT == /* && $ALERTS_TEST_ROOT != / ]] || { echo 'ERROR: Run as root.' >&2; exit 1; }
    root=$ALERTS_TEST_ROOT
fi
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
trap 'printf "ERROR: alerts rollback failed at line %s; rerun after fixing.\n" "$LINENO" >&2' ERR
[[ $# -eq 2 && $1 == --node && ( $2 == factory-gpu || $2 == factory-console ) ]] || fail 'Usage: rollback-alerts.sh --node factory-gpu|factory-console'
node=$2
for command in systemctl hostname rm rmdir curl sleep seq; do
    command -v "$command" >/dev/null || fail "Required command missing: $command"
done
[[ $(hostname -s) == "$node" ]] || fail "This host is $(hostname -s), not $node; nothing changed."
etc=$root/etc/factory-alerts
units=$root/etc/systemd/system
dropin_dir=$units/factory-api.service.d
dropin=$dropin_dir/50-factory-alerts.conf
lib=$root/usr/local/lib/factory-alerts

if [[ $node == factory-gpu ]]; then
    if [[ -e $dropin || -L $dropin ]]; then
        rm -f -- "$dropin"
        rmdir --ignore-fail-on-non-empty -- "$dropin_dir"
        systemctl daemon-reload
        if systemctl is-active --quiet factory-api.service; then
            systemctl restart factory-api.service
            for _ in $(seq 45); do
                if curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:8080/v1/health; then break; fi
                sleep 1
            done
            curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:8080/v1/health || fail 'factory-api is not healthy after restart; token left in place.'
        fi
        echo 'Removed the factory-api alerts drop-in; factory-api restarted without the token.'
    fi
else
    if [[ $(systemctl show factory-watchdog.service --property=LoadState --value) == loaded ]]; then
        systemctl disable --now factory-watchdog.timer
        systemctl stop factory-watchdog.service
        # DynamicUser state lives under /var/lib/private; let systemd remove it.
        systemctl clean --what=state factory-watchdog.service
    fi
    rm -f -- "$units/factory-watchdog.service" "$units/factory-watchdog.timer" "$lib/factory-watchdog.py"
    [[ ! -d $lib ]] || rmdir -- "$lib"
    systemctl daemon-reload
    echo 'Removed the factory-watchdog timer, service, script and state.'
fi
rm -f -- "$etc/slack-token"
[[ ! -d $etc ]] || rmdir --ignore-fail-on-non-empty -- "$etc"
echo "Removed /etc/factory-alerts/slack-token on $node."
