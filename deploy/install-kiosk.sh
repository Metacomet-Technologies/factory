#!/usr/bin/env bash
set -Eeuo pipefail
root=$(dirname "$(dirname "$(realpath "$0")")")
# --source-checkout only names the clean checkout the artifact's build identity must match (MET-239);
# units and helpers always come from this script's own tree, never from the caller (MET-375).
checkout=$root
if [[ ${1:-} == --source-checkout ]]; then
    checkout=${2:?Supply a clean source checkout after --source-checkout.}
    shift 2
fi
check_only=0
if [[ ${1:-} == --check-only ]]; then check_only=1; shift; fi
source_dir=${1:-/home/agent/work/factory/kiosk/dist}
destination=/var/lib/factory-api/kiosk
snapshot=
stage=
response=
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
# MET-375: from the staged root-owned tree, read only its verified assets (deploy/sudoers/README.md).
if [[ $0 == /usr/local/lib/factory-deploy/* || $root == /usr/local/lib/factory-deploy ]]; then
    # shellcheck source=SCRIPTDIR/sudoers/trusted-assets.sh
    source /usr/local/lib/factory-deploy/deploy/sudoers/trusted-assets.sh
    trusted_assets deploy/sudoers/trusted-assets.sh deploy/install-kiosk.sh deploy/rollback-kiosk.sh
fi
# MET-375: the allowlisted kiosk rollback (rollback-kiosk.sh itself is not allowlisted). As root it copies
# the snapshot over the served kiosk, so accept only an installer snapshot: a root-owned directory
# directly inside root-owned /var/backups/factory-kiosk, never a caller-chosen tree.
if [[ ${1:-} == --rollback ]]; then
    [[ $# -eq 2 ]] || fail 'Usage: install-kiosk.sh --rollback SNAPSHOT'
    [[ $EUID -eq 0 ]] || fail 'Run as root: bash deploy/install-kiosk.sh --rollback SNAPSHOT.'
    snapshot=$(realpath -e -- "$2") || fail "No snapshot directory: $2"
    [[ -d $snapshot && $(dirname "$snapshot") == /var/backups/factory-kiosk && $(stat -c %u "$snapshot") == 0 &&
        $(stat -c %u /var/backups/factory-kiosk) == 0 && $(( 8#$(stat -c %a /var/backups/factory-kiosk) & 8#022 )) == 0 ]] ||
        fail "Not an installer snapshot in /var/backups/factory-kiosk: $2"
    exec bash "$root/deploy/rollback-kiosk.sh" "$snapshot"
fi
# MET-239: refuse an artifact not built from this clean checkout. No override;
# a mismatch means rebuild. Runs before the root check and any change.
verify_artifact() {
    local name=$1 info=$2 checkout=$3 sha dirty head status
    sha=$(python3 -c 'import json, sys; v = json.loads(sys.argv[1]).get("git_sha"); print(v if isinstance(v, str) else "")' "$info" 2>/dev/null) \
        || fail "Artifact $name build info is not a JSON object; rebuild from $checkout."
    dirty=$(python3 -c 'import json, sys; print(json.dumps(json.loads(sys.argv[1]).get("git_dirty")))' "$info")
    head=$(sudo -u agent git -C "$checkout" rev-parse HEAD) || fail "Cannot read the checkout commit: $checkout"
    status=$(sudo -u agent git -C "$checkout" status --porcelain) || fail "Cannot read the checkout status: $checkout"
    [[ -n $sha && $sha != unknown ]] || fail "Artifact $name has no build SHA (missing or unknown); rebuild from $checkout."
    [[ $dirty == false ]] || fail "Artifact $name was built from a dirty tree (git_dirty: $dirty); rebuild from a clean checkout."
    [[ -z $status ]] || fail "Checkout $checkout is dirty; commit or discard changes, then rebuild."
    # Local builds embed the 7-char SHA, release artifacts the full one: accept either prefix of HEAD.
    [[ ${#sha} -ge 7 && $head == "$sha"* ]] || fail "Artifact $name built at $sha but checkout $checkout is at $head; rebuild at $head."
    printf 'Artifact %s built at %s matches checkout\n' "$name" "$sha"
}
[[ $# -le 1 ]] || fail 'Expected at most one built dist directory.'
[[ -f "$source_dir/version.json" && ! -L "$source_dir/version.json" ]] || fail "Built kiosk version.json missing: $source_dir; rebuild from $root/kiosk."
verify_artifact kiosk "$(<"$source_dir/version.json")" "$checkout"
[[ $EUID -eq 0 ]] || fail 'Run as root: bash deploy/install-kiosk.sh [--check-only] [built-dist-directory].'
trap 'printf "ERROR: kiosk install failed at line %s. Snapshot: %s. Recover with: bash deploy/rollback-kiosk.sh <snapshot>\n" "$LINENO" "${snapshot:-not created (kiosk unchanged)}" >&2' ERR
trap '[[ -z "$stage" ]] || rm -rf -- "$stage"; [[ -z "$response" ]] || rm -f -- "$response"' EXIT

# Preflight is read-only. Never build, change service state, or accept symlink trees.
for command in curl cmp getent id realpath find install cp chown chmod mktemp mv rm touch date flock; do
    command -v "$command" >/dev/null || fail "Required command missing: $command"
done
mv_help=$(mv --help)
[[ "$mv_help" == *--exchange* && "$mv_help" == *--no-copy* ]] || fail 'GNU mv with --exchange and --no-copy is required.'
id factory-api >/dev/null
[[ $(id -u factory-api) -ne 0 ]] || fail 'factory-api must not be a root account.'
getent group factory-api >/dev/null
[[ -d /var/lib/factory-api && ! -L /var/lib/factory-api ]] || fail 'factory-api state directory is missing or is a symlink.'
[[ -d "$source_dir" && ! -L "$source_dir" && -f "$source_dir/index.html" ]] || fail "Built kiosk index.html missing: $source_dir"
source_dir=$(realpath "$source_dir")
[[ "$source_dir" != "$destination" && "$source_dir" != "$destination/"* && "$destination" != "$source_dir/"* ]] || fail 'Use a separate built dist directory, not an ancestor of the destination.'
entries=$(find "$source_dir" ! -type d ! -type f -print -quit)
[[ -z "$entries" ]] || fail 'Dist must contain only regular files and directories (no symlinks).'
[[ ! -L "$destination" && ( ! -e "$destination" || -d "$destination" ) ]] || fail 'Unsafe kiosk destination.'
[[ ! -L /var/backups/factory-kiosk && ( ! -e /var/backups/factory-kiosk || -d /var/backups/factory-kiosk ) ]] || fail 'Unsafe kiosk backup directory.'
curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:8080/v1/health
if (( check_only )); then
    printf 'Check only: kiosk preflight passed; nothing changed.\n'
    exit 0
fi

# Serialize install/rollback; each snapshot records the complete previous tree or absence.
install -d -m 0700 /var/backups/factory-kiosk
exec 9>/var/backups/factory-kiosk/.lock
flock -n 9 || fail 'Another kiosk install or rollback is running.'
snapshot=$(mktemp -d "/var/backups/factory-kiosk/$(date -u +%Y%m%dT%H%M%S.%NZ).XXXXXX")
if [[ -d "$destination" ]]; then
    entries=$(find "$destination" ! -type d ! -type f -print -quit)
    [[ -z "$entries" ]] || fail 'Existing kiosk contains non-regular entries; review before replacing.'
    cp -a -- "$destination" "$snapshot/kiosk"
else
    touch "$snapshot/kiosk.missing"
fi
touch "$snapshot/complete"
printf 'Rollback snapshot: %s\n' "$snapshot"

stage=$(mktemp -d /var/lib/factory-api/.kiosk-install.XXXXXX)
cp -a -- "$source_dir/." "$stage/"
chown -R root:factory-api "$stage"
find "$stage" -type d -exec chmod 0550 {} +
find "$stage" -type f -exec chmod 0440 {} +
if [[ -d "$destination" ]]; then
    mv --exchange --no-copy -T -- "$stage" "$destination"
else
    mv --no-copy -T -- "$stage" "$destination"
    stage=
fi
response=$(mktemp)
curl -fsS --max-time 10 -H 'Accept: text/html' -o "$response" http://127.0.0.1:8080/
cmp -s -- "$destination/index.html" "$response" || fail "GET / does not match the installed index.html. Restore with: bash deploy/rollback-kiosk.sh $snapshot"
printf 'Kiosk installed and GET / verified. No service restart.\n'
