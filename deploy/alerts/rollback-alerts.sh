#!/usr/bin/env bash
# MET-150 rollback.
#   rollback-alerts.sh --node <node> <snapshot>  restores exactly what install-alerts.sh
#       saved before that run: the previous token, drop-in or watchdog files, and
#       unit state. A first-install snapshot (nothing existed) removes everything.
#   rollback-alerts.sh --node <node>             removes everything the installer adds.
# Removal order on factory-gpu: drop-in first (restart factory-api without it),
# then the token. factory-api's /var/lib/factory-api/alerts.json is left in place;
# without the token the engine only evaluates and logs.
set -Eeuo pipefail
umask 0077
root=
if (( EUID != 0 )); then
    [[ -n ${ALERTS_TEST_ROOT:-} && -d $ALERTS_TEST_ROOT && $ALERTS_TEST_ROOT == /* && $ALERTS_TEST_ROOT != / ]] || { echo 'ERROR: Run as root.' >&2; exit 1; }
    root=$ALERTS_TEST_ROOT
fi
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
trap 'printf "ERROR: alerts rollback failed at line %s; rerun after fixing.\n" "$LINENO" >&2' ERR
[[ ( $# -eq 2 || $# -eq 3 ) && $1 == --node && ( $2 == factory-gpu || $2 == factory-console ) ]] \
    || fail 'Usage: rollback-alerts.sh --node factory-gpu|factory-console [snapshot-directory]'
node=$2
snapshot=${3:-}
for command in systemctl hostname install rm rmdir curl sleep seq cat dirname; do
    command -v "$command" >/dev/null || fail "Required command missing: $command"
done
[[ $(hostname -s) == "$node" ]] || fail "This host is $(hostname -s), not $node; nothing changed."
etc=$root/etc/factory-alerts
token_file=$etc/slack-token
units=$root/etc/systemd/system
dropin_dir=$units/factory-api.service.d
dropin=$dropin_dir/50-factory-alerts.conf
lib=$root/usr/local/lib/factory-alerts
if [[ -n $snapshot ]]; then
    [[ -d $snapshot && ! -L $snapshot && -f $snapshot/complete ]] || fail "Not a complete snapshot: $snapshot"
    [[ $(cat "$snapshot/node") == "$node" ]] || fail "Snapshot is for $(cat "$snapshot/node"), not $node."
fi
# restore <snapshot-name> <installed-path> <mode>: previous copy, or absent.
restore() {
    if [[ -z $snapshot || -e $snapshot/$1.missing ]]; then
        rm -f -- "$2"
    else
        [[ -f $snapshot/$1 ]] || fail "Snapshot lacks $1."
        install -d -m "$( [[ $2 == "$token_file" ]] && echo 0700 || echo 0755 )" "$(dirname "$2")"
        install -m "$3" "$snapshot/$1" "$2"
    fi
}
first_install() { [[ -z $snapshot || -e $snapshot/$1.missing ]]; }
wait_healthy() {
    for _ in $(seq 45); do
        if curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:8080/v1/health; then return 0; fi
        sleep 1
    done
    curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:8080/v1/health
}

if [[ $node == factory-gpu ]]; then
    restore factory-api-alerts.conf "$dropin" 0644
    [[ ! -d $dropin_dir ]] || rmdir --ignore-fail-on-non-empty -- "$dropin_dir"
    restore slack-token "$token_file" 0600
    systemctl daemon-reload
    # Snapshot: bring factory-api back to its recorded state. Removal: restart only if running.
    if [[ -n $snapshot ]]; then previous=$(cat "$snapshot/api-active"); else
        previous=$(systemctl is-active factory-api.service 2>/dev/null || true)
    fi
    if [[ $previous == active ]]; then
        systemctl restart factory-api.service
        wait_healthy || fail 'factory-api is not healthy after restart.'
        echo 'factory-api restarted with the restored credential configuration.'
    fi
    echo 'factory-api alert drop-in and token restored to the snapshot state.'
else
    if first_install factory-watchdog.timer; then
        if [[ $(systemctl show factory-watchdog.service --property=LoadState --value) == loaded ]]; then
            systemctl disable --now factory-watchdog.timer
            systemctl stop factory-watchdog.service
            # DynamicUser state lives under /var/lib/private; let systemd remove it.
            systemctl clean --what=state factory-watchdog.service
        fi
    fi
    restore factory-watchdog.py "$lib/factory-watchdog.py" 0755
    restore factory-watchdog.service "$units/factory-watchdog.service" 0644
    restore factory-watchdog.timer "$units/factory-watchdog.timer" 0644
    [[ ! -d $lib ]] || rmdir --ignore-fail-on-non-empty -- "$lib"
    restore slack-token "$token_file" 0600
    systemctl daemon-reload
    if ! first_install factory-watchdog.timer; then
        case $(cat "$snapshot/timer-enabled") in
            enabled) systemctl enable factory-watchdog.timer ;;
            *) systemctl disable factory-watchdog.timer ;;
        esac
        case $(cat "$snapshot/timer-active") in
            active) systemctl restart factory-watchdog.timer ;;
            *) systemctl stop factory-watchdog.timer ;;
        esac
    fi
    echo 'factory-watchdog files and timer state restored to the snapshot state.'
fi
[[ ! -d $etc ]] || rmdir --ignore-fail-on-non-empty -- "$etc"
if [[ -z $snapshot ]]; then echo "Removed the alert configuration and token from $node."; fi
