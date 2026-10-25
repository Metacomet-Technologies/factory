#!/usr/bin/env bash
set -Eeuo pipefail
umask 0022
here=$(dirname "$(realpath "$0")")
runtime=/opt/factory-backup-r2
snapshot=
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run install-offsite-runtime.sh as root.'
[[ $# -eq 0 ]] || fail 'Usage: install-offsite-runtime.sh'
trap 'printf "ERROR: runtime install failed at line %s; rerun or use rollback-offsite-runtime.sh %s\n" "$LINENO" "${snapshot:-SNAPSHOT}" >&2' ERR
for tool in python3 install cp cmp mktemp flock timeout; do command -v "$tool" >/dev/null; done
python3 -c 'import venv, ensurepip, sys; assert sys.version_info >= (3, 11)'
[[ -f $here/offsite-requirements.txt ]] || fail 'Missing hash-locked requirements.'
for path in "$runtime" /opt/factory-backup-r2-snapshots; do
    while [[ $path != / ]]; do
        [[ ! -L $path ]] || fail "Refusing symlink: $path"
        path=$(dirname "$path")
    done
done
[[ ! -e $runtime || -d $runtime ]] || fail 'Runtime is not a directory.'
# Both runtime scripts lock the existing directory without creating a file.
exec 9</opt
flock -w 30 9
probe='import boto3, pyrage, importlib.metadata as m; assert m.version("boto3") == "1.43.118"; assert m.version("pyrage") == "1.4.0"'
if [[ -f $runtime/requirements.txt ]] && cmp -s "$here/offsite-requirements.txt" "$runtime/requirements.txt" \
    && timeout 30 "$runtime/bin/python" -I -c "$probe" \
    && timeout 30 "$runtime/bin/python" -I -m pip --isolated check; then
    echo 'Off-site runtime already matches the lock; no changes.'
    exit 0
fi
snapshot=/opt/factory-backup-r2-snapshots
install -d -o root -g root -m 0700 "$snapshot"
snapshot=$(mktemp -d "$snapshot/install.XXXXXX")
if [[ -d $runtime ]]; then cp -a "$runtime" "$snapshot/runtime"; else touch "$snapshot/absent"; fi
touch "$snapshot/complete"
printf 'Runtime rollback: bash %q %q\n' "$here/rollback-offsite-runtime.sh" "$snapshot"
# Build at the final path: venv entry points contain absolute interpreter paths.
rm -rf -- "$runtime"
python3 -m venv "$runtime"
timeout --kill-after=10s 10m "$runtime/bin/python" -I -m pip --isolated install \
    --index-url https://pypi.org/simple --require-hashes --only-binary=:all: --no-cache-dir \
    -r "$here/offsite-requirements.txt"
timeout 30 "$runtime/bin/python" -I -m pip --isolated check
timeout 30 "$runtime/bin/python" -I -c "$probe"
install -o root -g root -m 0644 "$here/offsite-requirements.txt" "$runtime/requirements.txt"
chown -R root:root "$runtime"
chmod -R go-w "$runtime"
echo 'Off-site runtime ready; no units, credentials or backup data changed.'
