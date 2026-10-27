#!/usr/bin/env bash
# MET-375: Devon, as root, stages the root-owned tree the agent allowlist runs and then activates the
# matching sudoers entries (deploy/sudoers/README.md). Run it from a deployment.tar.gz that root
# downloaded, checked against the pinned digest of the immutable GitHub release and unpacked into a
# root-only directory. Deliberately not in the allowlist: replacing privileged wrappers is human-only.
#   bash UNPACKED/deploy/sudoers/stage-trusted.sh UNPACKED
set -Eeuo pipefail
umask 0022
tree=/usr/local/lib/factory-deploy
new=
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
trap 'printf "ERROR: staging failed at line %s; inspect %s, %s.previous and /etc/sudoers.d/factory-agent-deploy (README rollback).\n" "$LINENO" "$tree" "$tree" >&2' ERR
trap '[[ -z "$new" ]] || rm -rf -- "$new"' EXIT
[[ $EUID -eq 0 ]] || fail 'Run as root.'
[[ $# -eq 1 ]] || fail 'Usage: stage-trusted.sh UNPACKED_DEPLOYMENT_TREE'
for command in python3 find sha256sum stat realpath mktemp cp chown chmod mv rm install visudo sudo systemctl hostname grep sort xargs cut; do
    command -v "$command" >/dev/null || fail "Required command missing: $command"
done
mv_help=$(mv --help)
[[ "$mv_help" == *--exchange* && "$mv_help" == *--no-copy* ]] || fail 'GNU mv with --exchange and --no-copy is required.'

# Read-only preflight: the unpacked release, the running deployer, the destination.
source=$(realpath -e -- "$1")
[[ -d $source && $(stat -c %u "$source") == 0 && $(( 8#$(stat -c %a "$source") & 8#077 )) == 0 ]] ||
    fail "Unpack the verified archive into a root-only (0700) directory, not $source."
[[ -f $source/release-source.json && -f $source/deploy/sudoers/trusted-assets.sh && -f $source/deploy/sudoers/factory-agent-deploy ]] ||
    fail "$source is not an unpacked deployment.tar.gz."
[[ -z $(find "$source" ! -type f ! -type d -print -quit) ]] || fail 'The unpacked release contains a symlink or special file.'
release=$(python3 -I -c 'import json, re, sys; s = json.load(open(sys.argv[1]))["source_sha"]; assert re.fullmatch("[0-9a-f]{40}", s); print(s)' \
    "$source/release-source.json") || fail 'release-source.json has no source SHA.'
visudo -c -f "$source/deploy/sudoers/factory-agent-deploy" >/dev/null || fail 'The release sudoers file does not parse.'
[[ $(hostname -s) == factory-gpu ]] || fail 'Stage only on factory-gpu; no other host has agent deploy entries.'
# The deployer reads the staged tree and refuses when it is missing; an older one would call the agent checkout.
deployer=/home/agent/factory-tools/current/scripts/odd/deploy.ts
grep -qF "export const TRUSTED = '$tree';" "$deployer" ||
    fail "$deployer does not call $tree yet; wait for tools-promoted to a release containing MET-375."
case $(systemctl show factory-deploy.service --property=ActiveState --value) in
    inactive|failed) ;;
    *) fail 'Stop factory-deploy.timer and wait for factory-deploy.service to finish first.' ;;
esac
[[ -d /usr/local/lib && ! -L /usr/local/lib && $(stat -c %u /usr/local/lib) == 0 ]] || fail 'Unsafe /usr/local/lib.'
for path in "$tree" "$tree.previous"; do
    [[ ! -L $path && ( ! -e $path || -d $path ) ]] || fail "Unsafe existing path: $path"
done

# Copy into a fresh root-only directory, make it root-owned and read-only to others, record every digest.
new=$(mktemp -d /usr/local/lib/.factory-deploy.XXXXXX)
cp -R -- "$source/." "$new/"
chown -R root:root "$new"
chmod -R u+rwX,go+rX,go-w "$new"
(cd "$new" && find . -type f -printf '%P\0' | LC_ALL=C sort -z | xargs -0 sha256sum --) > "$new/.SHA256SUMS"
mv -T -- "$new/.SHA256SUMS" "$new/SHA256SUMS"
chmod 0644 "$new/SHA256SUMS"
chmod 0755 "$new"
if [[ -d $tree ]]; then
    mv --exchange --no-copy -T -- "$new" "$tree"
    rm -rf -- "$tree.previous"
    mv --no-copy -T -- "$new" "$tree.previous"
    printf 'Previous tree kept at %s.previous\n' "$tree"
else
    mv --no-copy -T -- "$new" "$tree"
fi
new=

# Validate the staged tree exactly as the installers will, then activate its exact sudoers entries.
# shellcheck source=SCRIPTDIR/trusted-assets.sh
source "$tree/deploy/sudoers/trusted-assets.sh"
trusted_assets deploy/sudoers/trusted-assets.sh deploy/sudoers/factory-agent-deploy \
    deploy/install-meter.sh deploy/meter.service deploy/set_ollama_host.py deploy/rollback-meter-v1.sh \
    deploy/install-factory-api.sh deploy/factory-api.service deploy/alerts/factory-api-alerts.conf deploy/device-tokens.sh \
    deploy/rollback-factory-api.sh deploy/install-kiosk.sh deploy/rollback-kiosk.sh
printf 'Staged %s from release source %s; SHA256SUMS %s\n' "$tree" "$release" "$(sha256sum < "$tree/SHA256SUMS" | cut -d' ' -f1)"
visudo -c -f "$tree/deploy/sudoers/factory-agent-deploy"
install -o root -g root -m 0440 "$tree/deploy/sudoers/factory-agent-deploy" /etc/sudoers.d/factory-agent-deploy
visudo -c
sudo -l -U agent
