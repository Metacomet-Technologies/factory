#!/usr/bin/env bash
# MET-219: remote device credential hashes for factory-api (docs/devices-ingest.md).
#   install-factory-api.sh --enroll-device <device_id> [--label <label>]   token on stdin
#   rollback-factory-api.sh --unenroll-device <enrollment-snapshot>
# Only `<device_id> <sha256 hex> <label>` lines reach /etc/factory-api/device-tokens
# (root:factory-api 0640). The token arrives on stdin only, never argv or env, and is
# never printed. factory-api rereads the file when it changes; nothing restarts.
set -Eeuo pipefail
umask 0077
root=
# Test overrides are available only to unprivileged fake-root tests, never sudo.
if (( EUID != 0 )); then
    [[ -n ${FACTORY_API_TEST_ROOT:-} && -d $FACTORY_API_TEST_ROOT && $FACTORY_API_TEST_ROOT == /* && $FACTORY_API_TEST_ROOT != / ]] || { echo 'ERROR: Run as root.' >&2; exit 1; }
    root=$FACTORY_API_TEST_ROOT
fi
etc=$root/etc/factory-api
file=$etc/device-tokens
backups=$root/var/backups/factory-api
installer=$(dirname "$(realpath "$0")")/rollback-factory-api.sh
staging=
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
trap 'printf "ERROR: device credential step failed at line %s; the hash file is unchanged unless a message above says otherwise.\n" "$LINENO" >&2' ERR
trap '[[ -z $staging ]] || rm -f -- "$staging"' EXIT

preflight() {
    for command in sha256sum install mktemp mv chmod date flock grep awk; do
        command -v "$command" >/dev/null || fail "Required command missing: $command"
    done
    for path in "$root/etc" "$etc" "$file" "$root/var" "$root/var/backups" "$backups"; do
        [[ ! -L $path ]] || fail "Refusing symlink: $path"
    done
    [[ ! -e $etc || -d $etc ]] || fail "Not a directory: ${etc#"$root"}"
    [[ ! -e $file || -f $file ]] || fail "Not a regular file: ${file#"$root"}"
    if [[ -z $root ]]; then
        getent group factory-api >/dev/null || fail 'The factory-api group does not exist; install factory-api first.'
    fi
}

# Replace the file atomically with the given content, keeping root:factory-api 0640.
publish() {
    staging=$(mktemp "$etc/.device-tokens.XXXXXX")
    printf '%s' "$1" > "$staging"
    chmod 0640 "$staging"
    if [[ -z $root ]]; then chown root:factory-api "$staging"; fi
    mv -f -- "$staging" "$file"
    staging=
}

enroll() {
    local device=${1:-} label
    label="enrolled-$(date -u +%Y%m%dT%H%M%SZ)"
    shift || true
    while (( $# )); do
        case $1 in
            --label) (( $# >= 2 )) || fail 'Usage: --enroll-device <device_id> [--label <label>]'; label=$2; shift 2 ;;
            *) fail 'Usage: --enroll-device <device_id> [--label <label>]; the token goes on stdin, never in arguments.' ;;
        esac
    done
    [[ $device =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || fail 'Device id must match ^[a-z0-9][a-z0-9-]{0,62}$.'
    case $device in factory-gpu|fs|smart|cpu|telemetry) fail "Device id $device is reserved." ;; esac
    [[ $label =~ ^[A-Za-z0-9._:-]{1,64}$ ]] || fail 'Label must be 1-64 characters from A-Z a-z 0-9 . _ : -'
    preflight
    [[ ! -t 0 ]] || fail "Pipe the token on stdin (op read ... | gpu-ssh 'sudo bash ... --enroll-device $device')."
    local token=
    IFS= read -r -t 30 token || [[ -n $token ]] || fail 'No token on stdin; nothing changed.'
    token=${token%$'\r'}
    [[ $token =~ ^fdv1_[A-Za-z0-9_-]{43}$ ]] || { token=; fail 'stdin is not a device token (expected fdv1_ plus 43 base64url characters); nothing changed.'; }
    local hash
    hash=$(printf '%s' "$token" | sha256sum | awk '{print $1}')
    token=
    [[ $hash =~ ^[0-9a-f]{64}$ ]] || fail 'Hashing failed; nothing changed.'

    local dir_existed=yes file_existed=yes
    [[ -d $etc ]] || dir_existed=no
    [[ -f $file ]] || file_existed=no
    install -d -m 0750 "$etc"
    if [[ -z $root ]]; then chown root:factory-api "$etc"; fi
    exec 8<"$etc"
    flock -n 8 || fail 'Another device credential change is running.'
    local current=
    if [[ -f $file ]]; then current=$(<"$file"); fi
    if awk -v d="$device" -v h="$hash" '$1 == d && $2 == h { found = 1 } END { exit !found }' <<<"$current"; then
        echo "Already enrolled: $device has this credential; nothing changed."
        return 0
    fi
    if awk -v h="$hash" '$2 == h { found = 1 } END { exit !found }' <<<"$current"; then
        fail 'This token is already enrolled for another device; nothing changed.'
    fi
    local count
    count=$(awk -v d="$device" '$1 == d && $1 !~ /^#/ { n++ } END { print n + 0 }' <<<"$current")
    (( count < 2 )) || fail "$device already has two credentials; remove one (rollback-factory-api.sh --unenroll-device <snapshot>) first. Nothing changed."

    install -d -m 0700 "$backups"
    local snapshot
    snapshot=$(mktemp -d "$backups/enroll-$(date -u +%Y%m%dT%H%M%S.%NZ).XXXXXX")
    local line="$device $hash $label"
    printf '%s\n' "$line" > "$snapshot/line"
    printf '%s\n' "$file_existed" > "$snapshot/file-existed"
    printf '%s\n' "$dir_existed" > "$snapshot/dir-existed"
    touch "$snapshot/complete"
    # $(<file) drops trailing newlines; every entry ends with one again.
    publish "${current:+$current$'\n'}$line"$'\n'
    if [[ -z $root ]]; then
        sudo -u factory-api test -r "$file" || fail "factory-api cannot read ${file#"$root"}; undo with: sudo bash $installer --unenroll-device ${snapshot#"$root"}"
    fi
    echo "Enrolled $device ($label) in ${file#"$root"} (root:factory-api 0640). factory-api rereads it on change; no restart."
    printf 'Undo only this credential with: sudo bash %q --unenroll-device %q\n' "$installer" "${snapshot#"$root"}"
}

unenroll() {
    local snapshot=${1:-}
    (( $# == 1 )) || fail 'Usage: --unenroll-device <enrollment-snapshot>'
    snapshot=$root${snapshot#"$root"}
    [[ -f $snapshot/complete && -f $snapshot/line && -f $snapshot/file-existed && -f $snapshot/dir-existed ]] || fail 'Not a complete enrollment snapshot.'
    local line file_existed dir_existed
    line=$(<"$snapshot/line")
    file_existed=$(<"$snapshot/file-existed")
    dir_existed=$(<"$snapshot/dir-existed")
    [[ $line =~ ^[a-z0-9][a-z0-9-]{0,62}\ [0-9a-f]{64}\ [A-Za-z0-9._:-]{1,64}$ ]] || fail 'Snapshot line is malformed.'
    preflight
    if [[ ! -f $file ]]; then
        echo 'No device credential file; nothing changed.'
        return 0
    fi
    exec 8<"$etc"
    flock -n 8 || fail 'Another device credential change is running.'
    local kept
    kept=$(grep -Fxv -- "$line" "$file" || true)
    if [[ $kept == "$(<"$file")" ]]; then
        echo 'That credential line is already absent; nothing changed.'
        return 0
    fi
    if [[ -z $kept && $file_existed == no ]]; then
        rm -f -- "$file"
        if [[ $dir_existed == no ]]; then rmdir -- "$etc" 2>/dev/null || true; fi
        echo "Removed the enrolled line; ${file#"$root"} did not exist before, so it is gone again."
    else
        publish "${kept:+$kept$'\n'}"
        echo "Removed only the enrolled line from ${file#"$root"}; other credentials are unchanged."
    fi
}

case ${1:-} in
    enroll) shift; enroll "$@" ;;
    unenroll) shift; unenroll "$@" ;;
    *) fail 'Usage: device-tokens.sh enroll <device_id> [--label <label>] | unenroll <snapshot>' ;;
esac
