#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
here=$(dirname "$(realpath "$0")")
snapshot=/var/backups/factory-api-move/gpu
hint() { echo "Rollback: factory-ssh 'sudo bash /home/agent/work/factory/deploy/rollback-move-factory-api.sh gpu'; then console-ssh 'sudo bash /home/agent/work/factory/deploy/rollback-move-factory-api.sh console'" >&2; }
fail() { echo "ERROR: $*" >&2; hint; exit 1; }
trap 'echo "GPU move failed at line $LINENO" >&2; hint' ERR
dry=0
if [[ ${1:-} == --dry-run ]]; then dry=1; shift; fi
[[ $# == 4 ]] || fail 'Usage: move-factory-api-to-gpu.sh [--dry-run] <binary> <kiosk-dist> <bundle> <expected-short-git-sha>'
binary=$(realpath "$1") dist=$(realpath "$2") bundle=$(realpath "$3") sha=$4
[[ $sha =~ ^[0-9a-f]{7,40}$ ]] || fail 'Expected SHA must be hexadecimal.'
[[ -f "$binary" && -x "$binary" && -f "$dist/index.html" && -f "$dist/version.json" ]] || fail 'Missing prebuilt binary/index/version.json.'
[[ -z $(find "$dist" ! -type f ! -type d -print -quit) ]] || fail 'Unsafe dist tree.'
for command in python3 zstd sha256sum; do command -v "$command" >/dev/null; done
# Artifact-only preflight is safe unprivileged; no production endpoints or DBs.
python3 "$here/move-db.py" verify "$bundle"
if (( dry )); then
    echo 'Artifact preflight passed. Apply requires root on GPU, stopped console receipt, fresh GPU DBs, installed MET-74, systemd/clock/account/disk checks from installer.'
    echo 'Apply: snapshot config; pause GPU backups; prepare installer; restore both DBs; compare every table as factory-api; start installer; verify endpoints; install kiosk. Serve is printed only.'
    hint
    exit 0
fi
[[ $EUID == 0 && $(hostname -s) == factory-gpu ]] || fail 'Run as root on factory-gpu only.'
for command in systemctl sudo curl jq ss install flock cp cmp stat mv chown chmod tee awk mktemp rmdir; do command -v "$command" >/dev/null; done
for path in /var/backups/factory-api-move "$snapshot" /var/lib/factory-api /etc/factory-backup/nodes.conf \
    /var/lib/factory-api/move-check /var/lib/factory-api/move-check/counts.json; do
    [[ ! -L "$path" ]] || fail "Refusing symlink: $path"
done
[[ -f /etc/factory-backup/nodes.conf && -d /var/backups/factory-db ]] || fail 'Install MET-74 first.'
[[ ! -e "$snapshot/rolled-back" ]] || fail 'Move was rolled back. Review retained GPU DBs and archive journal before any new move.'
mv_help=$(mv --help)
[[ "$mv_help" == *--exchange* && "$mv_help" == *--no-copy* ]] || fail 'Kiosk requires GNU mv --exchange --no-copy.'
bash "$here/install-factory-api.sh" "$binary" --check-only
if [[ ! -f "$snapshot/started" ]]; then
    ! systemctl is-active --quiet factory-api.service || fail 'GPU API is already running; do not overwrite its data.'
    for name in requests pricing; do
        for suffix in '' -wal -shm; do
            [[ ! -L /var/lib/factory-api/$name.db$suffix ]] || fail 'Refusing DB/sidecar symlink.'
            [[ ! -e /var/lib/factory-api/$name.db$suffix ]] ||
                [[ -f "$snapshot/restoring" ]] || fail 'GPU DB destination is not empty; preserve/review existing files before moving.'
        done
    done
fi
install -d -m 0700 "$snapshot"
exec 8>"$snapshot/lock"
flock -n 8 || fail 'Another GPU move is running.'
if [[ -f "$snapshot/counts.json" ]]; then
    cmp "$bundle/counts.json" "$snapshot/counts.json" || fail 'Rerun must use the original console bundle.'
else
    if [[ ! -f "$snapshot/nodes.conf" ]]; then
        cp -p /etc/factory-backup/nodes.conf "$snapshot/nodes.conf.tmp"
        mv "$snapshot/nodes.conf.tmp" "$snapshot/nodes.conf"
    fi
    cp "$bundle/counts.json" "$snapshot/counts.json.tmp"
    mv "$snapshot/counts.json.tmp" "$snapshot/counts.json"
fi
systemctl disable --now factory-backup.timer
systemctl stop factory-backup.service
if [[ ! -f "$snapshot/started" ]]; then
    bash "$here/install-factory-api.sh" "$binary" --prepare-only
    # Retry interruption only while writers have never been started. Preserve
    # any partial restore and sidecars instead of replaying or deleting them.
    exec 9>>/var/backups/factory-db/.backup.lock
    flock -n 9 || fail 'Backup/deployment in progress.'
    touch "$snapshot/restoring"
    preserved=$(mktemp -d "$snapshot/pre-restore.XXXXXX")
    for name in requests pricing; do
        for suffix in '' -wal -shm; do
            path=/var/lib/factory-api/$name.db$suffix
            if [[ -e "$path" ]]; then mv -- "$path" "$preserved/"; fi
        done
    done
    stage=$(mktemp -d /var/lib/factory-api/.move-restore.XXXXXX)
    python3 "$here/move-db.py" restore "$bundle" "$stage"
    chown factory-api:factory-api "$stage/requests.db" "$stage/pricing.db"
    chmod 0600 "$stage/requests.db" "$stage/pricing.db"
    # Same-filesystem renames publish only complete DBs, including after ENOSPC.
    mv -T "$stage/requests.db" /var/lib/factory-api/requests.db
    mv -T "$stage/pricing.db" /var/lib/factory-api/pricing.db
    rmdir "$stage"
    # Root opens the source; the service user need not traverse /home/agent.
    install -d -o root -g factory-api -m 0750 /var/lib/factory-api/move-check
    install -o root -g factory-api -m 0640 "$bundle/counts.json" /var/lib/factory-api/move-check/counts.json
    # shellcheck disable=SC2024
    sudo -u factory-api python3 - compare /var/lib/factory-api/move-check /var/lib/factory-api < "$here/move-db.py" |
        tee "$snapshot/restored-counts.json"
    exec 9>&-
    touch "$snapshot/started"
fi
bash "$here/install-factory-api.sh" "$binary"
health=$(sudo -u factory-api curl -fsS --max-time 10 http://127.0.0.1:8080/v1/health)
jq -e --arg version "$(cat "$here/../VERSION")" --arg sha "$sha" \
    '.status == "ok" and .version == $version and .git_sha == $sha and .git_dirty == false' <<< "$health" || fail 'Health version/SHA/clean-build mismatch.'
[[ $(ss -H -ltn 'sport = :8080' | awk '{print $4}') == 127.0.0.1:8080 ]] || fail 'API must listen only on 127.0.0.1:8080.'
for endpoint in fleet llm/usage pricing; do
    sudo -u factory-api curl -fsS --max-time 30 "http://127.0.0.1:8080/v1/$endpoint" | jq -e .
done
bash "$here/install-kiosk.sh" "$dist"
sudo -u factory-api curl -fsS --max-time 10 http://127.0.0.1:8080/version.json | cmp - "$dist/version.json"
touch "$snapshot/complete"
cat <<'COMMANDS'
API/static move verified locally. Complete backup configuration on both nodes BEFORE switching Serve. From Mac, after reviewing existing Serve status:
factory-ssh 'sudo tailscale serve --bg --https=443 http://127.0.0.1:8080'
console-ssh 'sudo tailscale serve --bg --https=443 off'
Then switch the kiosk Exec URL using the MET-114 move runbook. These commands were NOT run.
COMMANDS
