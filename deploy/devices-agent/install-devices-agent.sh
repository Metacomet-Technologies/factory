#!/usr/bin/env bash
# Install the factory-console devices agent (docs/devices-ingest.md, stage B).
# Usage: install-devices-agent.sh BINARY [--check-only]
# The token is read from stdin only, never echoed, and written root:root 0600.
# Also installs phase 1's read-only SMART helper and timer for this node.
# Never touches factory-api, packages, firewall, Tailscale or reboot policy.
set -Eeuo pipefail
umask 0077
here=$(dirname "$(realpath "$0")")
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage='Usage: install-devices-agent.sh BINARY [--check-only]'
root=
if (( EUID != 0 )); then
    # Unprivileged fixture tests only: a fake root and PATH shims, no real changes.
    [[ -n ${DEVICES_AGENT_TEST_ROOT:-} && -d $DEVICES_AGENT_TEST_ROOT && $DEVICES_AGENT_TEST_ROOT == /* && $DEVICES_AGENT_TEST_ROOT != / ]] \
        || fail "Run as root: sudo bash $here/install-devices-agent.sh BINARY [--check-only]"
    root=$DEVICES_AGENT_TEST_ROOT
else
    unset DEVICES_AGENT_TEST_ROOT
    export PATH=/usr/sbin:/usr/bin:/sbin:/bin
fi
node=factory-console
user=factory-devices
check_only=false
binary=
while (( $# )); do
    case $1 in
        --check-only) check_only=true; shift ;;
        -*) fail "$usage" ;;
        *) [[ -z $binary ]] || fail "$usage"; binary=$1; shift ;;
    esac
done
[[ -n $binary ]] || fail "$usage"
for tool in systemctl hostname install cmp getent groupadd useradd usermod id stat mktemp mv python3 sha256sum od realpath; do
    command -v "$tool" >/dev/null || fail "Required command missing: $tool"
done
[[ $(hostname -s) == "$node" ]] || fail "This host is $(hostname -s), not $node; nothing changed."

bin=$root/usr/local/bin/factory-devices-agent
units=$root/etc/systemd/system
lib=$root/usr/local/lib/factory-devices
state=$root/var/lib/factory-devices
config=$root/etc/factory-devices-agent
token_file=$config/token
dropin=$units/factory-devices-smart.service.d/console.conf
# source|destination|mode
artifacts=(
    "$binary|$bin|0755"
    "$here/factory-devices-agent.service|$units/factory-devices-agent.service|0644"
    "$here/../devices/smart-snapshot.py|$lib/smart-snapshot.py|0755"
    "$here/../devices/factory-devices-smart.service|$units/factory-devices-smart.service|0644"
    "$here/../devices/factory-devices-smart.timer|$units/factory-devices-smart.timer|0644"
    "$here/smart-console.conf|$dropin|0644"
)
for entry in "${artifacts[@]}"; do
    IFS='|' read -r source destination _ <<<"$entry"
    [[ -f $source && -r $source ]] || fail "Missing artifact: $source"
    parent=$destination
    while [[ $parent != "${root:-/}" && $parent != / ]]; do
        [[ ! -L $parent ]] || fail "Refusing symlink destination: $parent"
        parent=$(dirname "$parent")
    done
done
for path in "$config" "$token_file" "$state"; do
    [[ ! -L $path ]] || fail "Refusing symlink destination: $path"
done
# Identify the prebuilt binary without running agent-built code as root.
[[ -f $binary && -x $binary ]] || fail "Prebuilt binary missing or not executable: $binary"
binary=$(realpath "$binary")
[[ $binary != "$(realpath -m "$bin")" ]] || fail 'Use a separate prebuilt binary, not the installed destination.'
[[ $(head -c 4 "$binary" | od -An -tx1 | tr -d ' \n') == 7f454c46 ]] || fail "Not an ELF binary: $binary"
grep -qaF factory_devices_agent "$binary" || fail "Not the devices agent: $binary"
version="sha256 $(sha256sum "$binary" | cut -c1-64)"
artifacts[0]="$binary|$bin|0755"

# Root-owned files; skipped in fixture tests, which cannot chown.
own() { [[ -n $root ]] || chown "$@"; }

user_ok() {
    local entry uid shell
    entry=$(getent passwd "$user") || return 1
    uid=$(cut -d: -f3 <<<"$entry")
    shell=$(cut -d: -f7 <<<"$entry")
    (( uid > 0 && uid < 1000 )) || fail "$user exists but is not a system user (uid $uid)."
    [[ $shell == */nologin || $shell == */false ]] || fail "$user exists with a login shell: $shell"
}

# A published status file the agent may read through its group. Membership is
# granted only when the file is group-readable, not group-writable, its
# directory is not group-writable, and the group is not root.
readable_group() {
    local file=$1 dir mode dir_mode group
    if [[ ! -e $file ]]; then
        echo "Not published: $file (the agent reports it unsupported)." >&2
        return 1
    fi
    [[ -f $file && ! -L $file ]] || { echo "Skipping $file: not a regular file." >&2; return 1; }
    dir=$(dirname "$file")
    mode=$((8#$(stat -c %a "$file")))
    dir_mode=$((8#$(stat -c %a "$dir")))
    group=$(stat -c %G "$file")
    if (( !(mode & 8#040) || (mode & 8#020) || (dir_mode & 8#020) )) || [[ $group == root || $group == "$user" ]] \
        || [[ $(stat -c %G "$dir") != "$group" ]] || (( !(dir_mode & 8#010) )); then
        echo "Skipping $file: not published read-only to a dedicated group." >&2
        return 1
    fi
    echo "$group"
}

published=("$root/var/lib/factory-reboot-status/status.json" "$root/var/lib/factory-backup-status/status.json")
groups=()
for file in "${published[@]}"; do
    if group=$(readable_group "$file"); then
        groups+=("$group")
    fi
done

if $check_only; then
    echo "Host $node, binary $version."
    if user_ok; then echo "User $user exists."; else echo "User $user will be created."; fi
    for entry in "${artifacts[@]}"; do
        IFS='|' read -r source destination _ <<<"$entry"
        if cmp -s "$source" "$destination"; then
            echo "Up to date: ${destination#"$root"}"
        else
            echo "Will install: ${destination#"$root"}"
        fi
    done
    if [[ -f $token_file ]]; then
        echo "Token file exists: $(stat -c '%U:%G %a' "$token_file") (contents not read)."
    else
        echo 'Token file is missing; the install must receive the token on stdin.'
    fi
    for group in "${groups[@]}"; do echo "Will grant read-only group: $group"; done
    command -v smartctl >/dev/null && echo 'smartctl is installed.' \
        || echo 'smartctl is absent: SMART will be reported unsupported. This installer does not install packages.'
    echo 'Check only: nothing changed, stdin not read.'
    exit 0
fi

# Token: stdin only, never echoed or passed as an argument.
token=
if [[ ! -t 0 ]]; then
    IFS= read -r token || true
fi
if [[ -z $token ]]; then
    [[ -f $token_file ]] || fail "No token on stdin and $token_file is missing. Pipe it: op read '...' | sudo bash $0 BINARY"
elif [[ ! $token =~ ^fdv1_[A-Za-z0-9_-]{43}$ ]]; then
    token=
    fail 'The token on stdin is not an fdv1_ token; nothing changed.'
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 0700 "$root/var/backups/factory-devices-agent"
snapshot=$(mktemp -d "$root/var/backups/factory-devices-agent/$stamp.XXXXXX")
trap 'printf "ERROR: install failed at line %s. Rollback: sudo bash %q %q\n" "$LINENO" "$here/rollback-devices-agent.sh" "$snapshot" >&2' ERR
for entry in "${artifacts[@]}"; do
    IFS='|' read -r _ destination _ <<<"$entry"
    name=$(basename "$destination")
    if [[ -f $destination ]]; then
        cp -a "$destination" "$snapshot/$name"
    else
        : > "$snapshot/$name.absent"
    fi
done

getent group "$user" >/dev/null || groupadd --system "$user"
if ! user_ok; then
    useradd --system --gid "$user" --no-create-home --home-dir /nonexistent \
        --shell /usr/sbin/nologin --comment 'factory devices agent' "$user"
fi
for group in "${groups[@]}"; do
    if id -nG "$user" | tr ' ' '\n' | grep -qx -- "$group"; then
        echo "Already in read-only group $group."
    else
        usermod -aG "$group" "$user"
        echo "Granted read-only group $group."
    fi
done

install -d -m 0700 "$config"
own root:root "$config"
if [[ -n $token ]]; then
    if [[ -f $token_file ]] && [[ $(<"$token_file") == "$token" ]]; then
        echo 'Token unchanged.'
    else
        temporary=$(mktemp "$config/.token.XXXXXX")
        printf '%s\n' "$token" > "$temporary"
        chmod 0600 "$temporary"
        own root:root "$temporary"
        mv -f "$temporary" "$token_file"
        echo 'Token written.'
    fi
fi
token=
chmod 0600 "$token_file"
own root:root "$token_file"

for entry in "${artifacts[@]}"; do
    IFS='|' read -r source destination mode <<<"$entry"
    install -d -m 0755 "$(dirname "$destination")"
    install -m "$mode" "$source" "$destination"
    own root:root "$destination"
done
# SMART snapshot directory, readable by the agent's group only.
install -d -m 0750 "$state"
own "root:$user" "$state"
chmod 2750 "$state"
if [[ -f $state/smart.json && ! -L $state/smart.json ]]; then
    own "root:$user" "$state/smart.json"
    chmod 0640 "$state/smart.json"
fi

systemctl daemon-reload
systemctl enable --now factory-devices-smart.timer
systemctl enable factory-devices-agent.service
systemctl restart factory-devices-agent.service
echo "Installed factory-devices-agent ($version) as $user."
echo "Backup: $snapshot"
echo "Rollback: sudo bash $here/rollback-devices-agent.sh $snapshot"
