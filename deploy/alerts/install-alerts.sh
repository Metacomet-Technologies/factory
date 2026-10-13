#!/usr/bin/env bash
# MET-150: install the Slack alert bot token and what consumes it.
#   factory-gpu:     token + factory-api LoadCredential drop-in (restarts factory-api if either changed)
#   factory-console: token + watchdog script/service/timer (no restart needed for a token change)
# The token arrives on stdin only, never argv, env or a file in the repo; it is
# never printed. --test-alert posts one live test message plus a threaded reply.
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
usage='Usage: install-alerts.sh --node factory-gpu|factory-console [--test-alert]   (token on stdin unless --test-alert)'
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
trap 'printf "ERROR: alerts install failed at line %s. Undo with: sudo bash %q --node %q\n" "$LINENO" "$here/rollback-alerts.sh" "${node:-<node>}" >&2' ERR
test_alert=false
while (( $# )); do
    case $1 in
        --node) (( $# >= 2 )) || fail "$usage"; node=$2; shift 2 ;;
        --test-alert) test_alert=true; shift ;;
        *) fail "$usage" ;;
    esac
done
case $node in factory-gpu|factory-console) ;; *) fail "$usage" ;; esac
for command in systemctl systemd-run journalctl hostname install cmp mktemp mv rm chmod curl date sleep seq find grep; do
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
api_binary=$root/usr/local/bin/factory-api

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
    "$lib/factory-watchdog.py" "$units/factory-watchdog.service" "$units/factory-watchdog.timer"; do
    [[ ! -L $path ]] || fail "Refusing symlink: $path"
done
for path in "$etc" "$dropin_dir" "$lib"; do
    [[ ! -e $path || -d $path ]] || fail "Not a directory: $path"
done
if [[ $node == factory-gpu ]]; then
    [[ $(systemctl show factory-api.service --property=LoadState --value) == loaded ]] || fail 'factory-api.service is not installed.'
    "$api_binary" --help | grep -q -- '--alerts-state' || fail 'Installed factory-api predates MET-150; deploy that binary first.'
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

changed() { ! cmp -s "$1" "$2"; }
install -d -m 0700 "$etc"
staging=$(mktemp "$etc/.slack-token.XXXXXX")
trap 'rm -f -- "$staging"' EXIT
printf '%s\n' "$token" > "$staging"
token=
chmod 0600 "$staging"
token_changed=false
if changed "$staging" "$token_file"; then
    mv -f -- "$staging" "$token_file"
    token_changed=true
    echo "Token stored in $credential (root, 0600)."
else
    echo 'Token unchanged.'
fi

if [[ $node == factory-gpu ]]; then
    dropin_changed=false
    if changed "$here/factory-api-alerts.conf" "$dropin"; then
        install -d -m 0755 "$dropin_dir"
        install -m 0644 "$here/factory-api-alerts.conf" "$dropin"
        systemctl daemon-reload
        dropin_changed=true
        echo "Installed ${dropin#"$root"}."
    fi
    if ! $token_changed && ! $dropin_changed; then
        echo 'Nothing changed; factory-api not restarted.'
        exit 0
    fi
    if ! systemctl is-active --quiet factory-api.service; then
        echo 'factory-api is not active; it loads the credential when next started.'
        exit 0
    fi
    since=$(date +%s)
    systemctl restart factory-api.service
    for _ in $(seq 45); do
        if curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:8080/v1/health; then break; fi
        sleep 1
    done
    curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:8080/v1/health || fail 'factory-api is not healthy after restart.'
    journalctl -u factory-api.service --since "@$since" -o cat | grep -q 'Slack token loaded' \
        || fail 'factory-api restarted but did not report the Slack token as loaded.'
    echo 'factory-api restarted; health OK and Slack token loaded (posting enabled).'
else
    units_changed=false
    install -d -m 0755 "$lib" "$units"
    if changed "$here/factory-watchdog.py" "$lib/factory-watchdog.py"; then
        install -m 0755 "$here/factory-watchdog.py" "$lib/factory-watchdog.py"
        echo 'Installed watchdog script.'
    fi
    for unit in factory-watchdog.service factory-watchdog.timer; do
        if changed "$here/$unit" "$units/$unit"; then
            install -m 0644 "$here/$unit" "$units/$unit"
            units_changed=true
            echo "Installed $unit."
        fi
    done
    if $units_changed; then systemctl daemon-reload; fi
    systemctl enable factory-watchdog.timer
    if $units_changed && systemctl is-active --quiet factory-watchdog.timer; then
        systemctl restart factory-watchdog.timer
    else
        systemctl start factory-watchdog.timer
    fi
    # One run now (oneshot: start waits for it) proves the unit, credential and health check.
    systemctl start factory-watchdog.service
    journalctl -u factory-watchdog.service -n 3 -o cat || true
    systemctl is-active --quiet factory-watchdog.timer || fail 'factory-watchdog.timer is not active.'
    echo 'Watchdog timer active; it checks factory-gpu every minute.'
fi
