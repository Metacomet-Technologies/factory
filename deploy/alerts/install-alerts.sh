#!/usr/bin/env bash
# MET-150: install the Slack alert bot token and what consumes it.
#   factory-gpu:     token + factory-api LoadCredential drop-in (restarts factory-api if either changed)
#   factory-console: token + watchdog script/service/timer (no restart needed for a token change)
# The token arrives on stdin only, never argv, env or a file in the repo; it is
# never printed. Before changing anything the installer saves a root-only
# snapshot of the previous token, files and unit state; if any later step fails
# it restores that snapshot automatically. --test-alert posts one live test
# message plus a threaded reply.
set -Eeuo pipefail
umask 0077
here=$(dirname "$(realpath "$0")")
root=
# Test overrides are available only to unprivileged fake-root tests, never sudo.
if (( EUID != 0 )); then
    [[ -n ${ALERTS_TEST_ROOT:-} && -d $ALERTS_TEST_ROOT && $ALERTS_TEST_ROOT == /* && $ALERTS_TEST_ROOT != / ]] || { echo 'ERROR: Run as root.' >&2; exit 1; }
    root=$ALERTS_TEST_ROOT
fi
node=
snapshot=
staging=
changing=false
usage='Usage: install-alerts.sh --node factory-gpu|factory-console [--test-alert]   (token on stdin unless --test-alert)'
restore() {
    trap - ERR
    if ! $changing; then
        echo 'No deployment changes made.' >&2
        return
    fi
    printf 'Restoring the previous state from %s\n' "$snapshot" >&2
    if bash "$here/rollback-alerts.sh" --node "$node" "$snapshot" >&2; then
        echo 'Previous token, files and service state restored.' >&2
    else
        printf 'ERROR: automatic restore failed; retry: sudo bash %q --node %q %q\n' "$here/rollback-alerts.sh" "$node" "$snapshot" >&2
    fi
}
fail() { printf 'ERROR: %s\n' "$*" >&2; restore; exit 1; }
trap 'printf "ERROR: alerts install failed at line %s.\n" "$LINENO" >&2; restore; exit 1' ERR
trap '[[ -z $staging ]] || rm -rf -- "$staging"' EXIT
test_alert=false
while (( $# )); do
    case $1 in
        --node) (( $# >= 2 )) || fail "$usage"; node=$2; shift 2 ;;
        --test-alert) test_alert=true; shift ;;
        *) fail "$usage" ;;
    esac
done
case $node in factory-gpu|factory-console) ;; *) fail "$usage" ;; esac
for command in systemctl systemd-run journalctl hostname install cmp cp mktemp mv rm chmod touch curl date sleep seq find; do
    command -v "$command" >/dev/null || fail "Required command missing: $command"
done
[[ $(hostname -s) == "$node" ]] || fail "This host is $(hostname -s), not $node; nothing changed."
[[ -n $root || -d /run/systemd/system ]] || fail 'systemd is not running.'

credential=/etc/factory-alerts/slack-token
etc=$root/etc/factory-alerts
token_file=$root$credential
units=$root/etc/systemd/system
dropin_dir=$units/factory-api.service.d
dropin=$dropin_dir/50-factory-alerts.conf
lib=$root/usr/local/lib/factory-alerts
backups=$root/var/backups/factory-alerts
api_binary=$root/usr/local/bin/factory-api
watchdog_files=(factory-watchdog.py factory-watchdog.service factory-watchdog.timer)
installed() {
    case $1 in factory-watchdog.py) printf '%s\n' "$lib/$1" ;; *) printf '%s\n' "$units/$1" ;; esac
}

if $test_alert; then
    [[ -f $token_file ]] || fail "No token at $credential; run the installer first."
    if [[ $node == factory-gpu ]]; then
        systemd-run --wait --pipe --quiet --collect -p User=factory-api \
            -p "LoadCredential=slack-bot-token:$credential" /usr/local/bin/factory-api alert-test
    else
        systemd-run --wait --pipe --quiet --collect -p DynamicUser=yes \
            -p "LoadCredential=slack-bot-token:$credential" \
            /usr/bin/python3 -I /usr/local/lib/factory-alerts/factory-watchdog.py --test-alert
    fi
    exit 0
fi

# Preflight: every check runs before reading the token or changing anything.
[[ ! -t 0 ]] || fail 'Pipe the token on stdin (op read ... | ssh ... install-alerts.sh --node ...).'
for path in "$root/etc" "$etc" "$token_file" "$units" "$dropin_dir" "$dropin" "$root/usr/local/lib" "$lib" \
    "$root/var" "$root/var/backups" "$backups"; do
    [[ ! -L $path ]] || fail "Refusing symlink: $path"
done
for name in "${watchdog_files[@]}"; do
    path=$(installed "$name")
    [[ ! -L $path && ( ! -e $path || -f $path ) ]] || fail "Unsafe file: $path"
done
for path in "$etc" "$dropin_dir" "$lib" "$backups"; do
    [[ ! -e $path || -d $path ]] || fail "Not a directory: $path"
done
[[ ! -e $token_file || -f $token_file ]] || fail "Not a regular file: $token_file"
if [[ $node == factory-gpu ]]; then
    [[ $(systemctl show factory-api.service --property=LoadState --value) == loaded ]] || fail 'factory-api.service is not installed.'
    help=$("$api_binary" --help 2>&1 || true)
    [[ $help == *--alerts-state* ]] || fail 'Installed factory-api predates MET-150; deploy that binary first.'
    if [[ -d $dropin_dir ]]; then
        extra=$(find "$dropin_dir" -mindepth 1 ! -path "$dropin" -print -quit)
        [[ -z $extra ]] || fail "Unexpected factory-api drop-in: $extra; review it first."
    fi
    dropins=$(systemctl show factory-api.service --property=DropInPaths --value)
    [[ -z $dropins || $dropins == "${dropin#"$root"}" ]] || fail "Unexpected factory-api drop-ins: $dropins"
else
    [[ -n $root || -x /usr/bin/python3 ]] || fail 'The watchdog needs /usr/bin/python3.'
    for unit in factory-watchdog.service factory-watchdog.timer; do
        [[ -z $(systemctl show "$unit" --property=DropInPaths --value) ]] || fail "Review $unit drop-ins first."
    done
fi

token=
IFS= read -r -t 30 token || [[ -n $token ]] || fail 'No token on stdin; nothing changed.'
token=${token%$'\r'}
[[ $token =~ ^xoxb-[A-Za-z0-9-]{10,250}$ ]] || fail 'stdin is not a Slack bot token (expected xoxb-...); nothing changed.'

# Stage the token in a root-only directory and work out what would change.
install -d -m 0700 "$backups"
staging=$(mktemp -d "$backups/.staging.XXXXXX")
printf '%s\n' "$token" > "$staging/slack-token"
token=
chmod 0600 "$staging/slack-token"
changed() { ! cmp -s "$1" "$2"; }
token_changed=false dropin_changed=false units_changed=false script_changed=false timer_state_changed=false
if changed "$staging/slack-token" "$token_file"; then token_changed=true; fi
if [[ $node == factory-gpu ]]; then
    if changed "$here/factory-api-alerts.conf" "$dropin"; then dropin_changed=true; fi
    api_state=$(systemctl is-active factory-api.service 2>/dev/null || true)
else
    if changed "$here/factory-watchdog.py" "$lib/factory-watchdog.py"; then script_changed=true; fi
    for unit in factory-watchdog.service factory-watchdog.timer; do
        if changed "$here/$unit" "$units/$unit"; then units_changed=true; fi
    done
    timer_enabled=$(systemctl is-enabled factory-watchdog.timer 2>/dev/null || true)
    timer_active=$(systemctl is-active factory-watchdog.timer 2>/dev/null || true)
    [[ $timer_enabled == enabled && $timer_active == active ]] || timer_state_changed=true
fi
if ! $token_changed && ! $dropin_changed && ! $units_changed && ! $script_changed && ! $timer_state_changed; then
    echo 'Nothing changed; no snapshot taken and nothing restarted.'
    exit 0
fi

# Root-only snapshot of everything this run may change, then apply.
snapshot=$(mktemp -d "$backups/$(date -u +%Y%m%dT%H%M%S.%NZ).XXXXXX")
printf '%s\n' "$node" > "$snapshot/node"
save() {  # save <installed-path> <snapshot-name>
    if [[ -e $1 ]]; then cp -p -- "$1" "$snapshot/$2"; else touch "$snapshot/$2.missing"; fi
}
save "$token_file" slack-token
if [[ $node == factory-gpu ]]; then
    save "$dropin" factory-api-alerts.conf
    printf '%s\n' "$api_state" > "$snapshot/api-active"
else
    for name in "${watchdog_files[@]}"; do save "$(installed "$name")" "$name"; done
    printf '%s\n' "$timer_enabled" > "$snapshot/timer-enabled"
    printf '%s\n' "$timer_active" > "$snapshot/timer-active"
fi
touch "$snapshot/complete"
printf 'Snapshot (root-only): %s\n' "${snapshot#"$root"}"
changing=true

install -d -m 0700 "$etc"
if $token_changed; then
    mv -f -- "$staging/slack-token" "$token_file"
    echo "Token stored in $credential (root, 0600)."
else
    echo 'Token unchanged.'
fi

if [[ $node == factory-gpu ]]; then
    if $dropin_changed; then
        install -d -m 0755 "$dropin_dir"
        install -m 0644 "$here/factory-api-alerts.conf" "$dropin"
        systemctl daemon-reload
        echo "Installed ${dropin#"$root"}."
    fi
    if [[ $api_state != active ]]; then
        echo 'factory-api is not active; it loads the credential when next started.'
    else
        since=$(date +%s)
        systemctl restart factory-api.service
        for _ in $(seq 45); do
            if curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:8080/v1/health; then break; fi
            sleep 1
        done
        curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:8080/v1/health || fail 'factory-api is not healthy after restart.'
        loaded=false
        for _ in $(seq 10); do
            journal=$(journalctl -u factory-api.service --since "@$since" -o cat 2>/dev/null || true)
            if [[ $journal == *'Slack token loaded'* ]]; then loaded=true; break; fi
            sleep 1
        done
        $loaded || fail 'factory-api restarted but did not report the Slack token as loaded.'
        echo 'factory-api restarted; health OK and Slack token loaded (posting enabled).'
    fi
else
    install -d -m 0755 "$lib" "$units"
    if $script_changed; then
        install -m 0755 "$here/factory-watchdog.py" "$lib/factory-watchdog.py"
        echo 'Installed watchdog script.'
    fi
    if $units_changed; then
        for unit in factory-watchdog.service factory-watchdog.timer; do
            install -m 0644 "$here/$unit" "$units/$unit"
        done
        systemctl daemon-reload
        echo 'Installed watchdog units.'
    fi
    systemctl enable factory-watchdog.timer
    if $units_changed && [[ $timer_active == active ]]; then
        systemctl restart factory-watchdog.timer
    else
        systemctl start factory-watchdog.timer
    fi
    # One run now (oneshot: start waits for it) proves the unit, credential and health check.
    systemctl start factory-watchdog.service || fail 'The first watchdog run failed.'
    journalctl -u factory-watchdog.service -n 3 -o cat || true
    systemctl is-active --quiet factory-watchdog.timer || fail 'factory-watchdog.timer is not active.'
    echo 'Watchdog timer active; it checks factory-gpu every minute.'
fi
printf 'Done. Undo with: sudo bash %q --node %q %q\n' "$here/rollback-alerts.sh" "$node" "${snapshot#"$root"}"
