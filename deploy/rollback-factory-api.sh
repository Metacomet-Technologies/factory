#!/usr/bin/env bash
set -Eeuo pipefail
umask 0077
repo=$(dirname "$(dirname "$(realpath "$0")")")
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
# MET-375: from the staged root-owned tree, read only its verified assets (deploy/sudoers/README.md).
if [[ $0 == /usr/local/lib/factory-deploy/* || $repo == /usr/local/lib/factory-deploy ]]; then
    # shellcheck source=SCRIPTDIR/sudoers/trusted-assets.sh
    source /usr/local/lib/factory-deploy/deploy/sudoers/trusted-assets.sh
    trusted_assets deploy/sudoers/trusted-assets.sh deploy/rollback-factory-api.sh deploy/alerts/factory-api-alerts.conf deploy/device-tokens.sh
fi
# MET-219: remove only the credential line one enrollment added.
if [[ ${1:-} == --unenroll-device ]]; then
    shift
    exec bash "$repo/deploy/device-tokens.sh" unenroll "$@"
fi
[[ $EUID -eq 0 ]] || fail 'Run as root: bash deploy/rollback-factory-api.sh <snapshot-directory>.'
[[ $# -eq 1 ]] || fail 'Supply the exact snapshot directory printed by the installer.'
# MET-375: the snapshot's binary and unit are installed as root, so accept only an installer snapshot:
# a root-owned directory directly inside root-owned /var/backups/factory-api, never a caller-chosen path.
snapshot=$(realpath -e -- "$1") || fail "No snapshot directory: $1"
[[ -d $snapshot && $(dirname "$snapshot") == /var/backups/factory-api && $(stat -c %u "$snapshot") == 0 &&
    $(stat -c %u /var/backups/factory-api) == 0 && $(( 8#$(stat -c %a /var/backups/factory-api) & 8#022 )) == 0 ]] ||
    fail "Not an installer snapshot in /var/backups/factory-api: $1"
trap 'printf "ERROR: rollback failed at line %s; snapshot retained at %s.\n" "$LINENO" "$snapshot" >&2' ERR
for command in systemctl cp rm cat mv mktemp date sudo curl touch sqlite3 jq flock sha256sum cmp find realpath install; do
    command -v "$command" >/dev/null || fail "Required command missing: $command"
done
[[ -f "$snapshot/complete" && -f "$snapshot/enabled" && -f "$snapshot/active" ]] || fail 'Snapshot is incomplete.'
for name in binary unit; do
    if [[ -f "$snapshot/$name" && ! -e "$snapshot/$name.missing" ]]; then
        :
    elif [[ -f "$snapshot/$name.missing" && ! -e "$snapshot/$name" ]]; then
        :
    else
        fail "Invalid snapshot entry: $name"
    fi
done
enabled=$(cat "$snapshot/enabled")
active=$(cat "$snapshot/active")
case "$enabled" in enabled|disabled|static|indirect|not-found) ;; *) fail "Invalid enable state: $enabled" ;; esac
case "$active" in active|inactive|failed|unknown) ;; *) fail "Invalid active state: $active" ;; esac
for path in /usr/local/bin/factory-api /etc/systemd/system/factory-api.service; do
    [[ ! -L "$path" && ( ! -e "$path" || -f "$path" ) ]] || fail "Unsafe destination: $path"
done

[[ -f "$snapshot/pricing-mode" ]] || fail 'Use the rollback script matching this snapshot; pricing mode is missing.'
pricing_mode=$(cat "$snapshot/pricing-mode")
case "$pricing_mode" in legacy|fresh|v1) ;; *) fail "Invalid pricing mode: $pricing_mode" ;; esac
[[ -f "$snapshot/requests-mode" ]] || fail 'Use the rollback script matching this snapshot; requests mode is missing.'
requests_mode=$(cat "$snapshot/requests-mode")
case "$requests_mode" in legacy|fresh|v4|v5|v6) ;; *) fail "Invalid requests mode: $requests_mode" ;; esac
# legacy/v4/v5 snapshots record their version and a verified backup before migration.
# Earlier installers recorded v4 (pre-MET-204) or v5 (pre-MET-205) without a
# version when no migration ran; v6 never migrates the requests DB.
restore_requests=true
case "$requests_mode" in
    v6) restore_requests=false ;;
    v4|v5) [[ -f "$snapshot/requests-version" ]] || restore_requests=false ;;
esac
requests_db=/var/lib/factory-api/requests.db
for path in "$requests_db" "$requests_db-wal" "$requests_db-shm" "$snapshot/requests.db"; do
    [[ ! -L "$path" && ( ! -e "$path" || -f "$path" ) ]] || fail "Unsafe requests file: $path"
done
if [[ "$restore_requests" == true && "$requests_mode" != fresh && -f "$snapshot/requests.db.sha256" ]]; then
    sha256sum -c "$snapshot/requests.db.sha256"
    [[ $(sqlite3 "file:$snapshot/requests.db?immutable=1" 'PRAGMA integrity_check;') == ok ]] || fail 'Requests snapshot integrity failed.'
fi
pricing_db=/var/lib/factory-api/pricing.db
legacy_db=/var/lib/factory-api/pricing.v0.db
for path in "$pricing_db" "$pricing_db-wal" "$pricing_db-shm" "$legacy_db" "$legacy_db-wal" "$legacy_db-shm"; do
    [[ ! -L "$path" && ( ! -e "$path" || -f "$path" ) ]] || fail "Unsafe pricing file: $path"
done
# MET-150's alert credential drop-in (deploy/alerts) is the only tolerated override.
alerts_dropin=/etc/systemd/system/factory-api.service.d/50-factory-alerts.conf
if [[ -d /etc/systemd/system/factory-api.service.d ]]; then
    extra=$(find /etc/systemd/system/factory-api.service.d -mindepth 1 ! -path "$alerts_dropin" -print -quit)
    [[ -z "$extra" && ! -L "$alerts_dropin" ]] || fail 'Review factory-api unit drop-ins before rollback.'
    [[ ! -e "$alerts_dropin" ]] || cmp -s "$alerts_dropin" "$repo/deploy/alerts/factory-api-alerts.conf" || fail 'Review factory-api unit drop-ins before rollback.'
fi
dropins=$(systemctl show factory-api.service --property=DropInPaths --value)
[[ -z "$dropins" || "$dropins" == "$alerts_dropin" ]] || fail 'Review factory-api unit drop-ins before rollback.'
if [[ "$pricing_mode" == legacy && -f "$legacy_db" ]]; then
    [[ -f "$snapshot/pricing.db.sha256" ]] || fail 'Verified legacy snapshot is missing.'
    sha256sum -c "$snapshot/pricing.db.sha256"
    [[ $(sqlite3 -readonly "$snapshot/pricing.db" 'PRAGMA integrity_check;') == ok ]] || fail 'Legacy snapshot integrity failed.'
fi
[[ -d /var/backups/factory-db && ! -L /var/backups/factory-db/.backup.lock ]] || fail 'MET-74 backup lock is unavailable.'
exec 9>>/var/backups/factory-db/.backup.lock
flock -n 9 || fail 'Backup or deployment is running; retry after it finishes.'

# Installation may have failed before writing/loading the new unit.
if [[ $(systemctl show factory-api.service --property=LoadState --value) != not-found ]]; then
    systemctl stop factory-api.service
    systemctl disable factory-api.service
fi
if [[ "$restore_requests" == true && ! -f "$snapshot/requests-restored" ]]; then
    if [[ "$requests_mode" != fresh && ! -f "$snapshot/requests.db.sha256" ]]; then
        [[ -f "$snapshot/requests-version" && -f "$requests_db" ]] || fail 'Requests backup is missing; refusing to restore the old binary.'
        [[ $(sudo -u factory-api sqlite3 -readonly "$requests_db" 'PRAGMA user_version;') == "$(cat "$snapshot/requests-version")" ]] || fail 'Requests schema changed without a verified backup; service remains stopped.'
    else
        aside=$(mktemp -d "$snapshot/requests-rollback-$(date -u +%Y%m%dT%H%M%S.%NZ).XXXXXX")
        for suffix in -wal -shm ''; do
            if [[ -e "$requests_db$suffix" ]]; then mv -- "$requests_db$suffix" "$aside/requests.db$suffix"; fi
        done
        if [[ "$requests_mode" != fresh ]]; then
            install -o factory-api -g factory-api -m 0600 "$snapshot/requests.db" "$requests_db"
            [[ $(sudo -u factory-api sqlite3 -readonly "$requests_db" 'PRAGMA user_version;') == "$(cat "$snapshot/requests-version")" ]] || fail 'Requests restore version failed; service remains stopped.'
        fi
        printf 'Requests rollback restores pre-migration telemetry; later writes retained at: %s\n' "$aside"
    fi
    touch "$snapshot/requests-restored"
fi
if [[ "$pricing_mode" != v1 && ! -f "$snapshot/pricing-restored" ]]; then
    # Unique directory keeps both databases and every displaced sidecar.
    aside=$(mktemp -d "$snapshot/rollback-$(date -u +%Y%m%dT%H%M%S.%NZ).XXXXXX")
    if [[ "$pricing_mode" == fresh ]]; then
        for suffix in -wal -shm ''; do
            if [[ -e "$pricing_db$suffix" ]]; then mv -- "$pricing_db$suffix" "$aside/pricing.db$suffix"; fi
        done
    else
        moved_main=false
        [[ ! -f "$legacy_db" ]] || moved_main=true
        if [[ "$moved_main" == false ]]; then
            [[ -f "$pricing_db" && $(sqlite3 -readonly "$pricing_db" 'PRAGMA user_version;') == 0 ]] || fail 'Legacy DB is missing; refusing to restore the old binary against v1.'
        fi
        # If installation stopped partway through moving legacy files, only
        # restore the files actually moved. Main file is restored last.
        for suffix in -wal -shm ''; do
            if [[ "$moved_main" == true || -e "$legacy_db$suffix" ]]; then
                if [[ -e "$pricing_db$suffix" ]]; then mv -- "$pricing_db$suffix" "$aside/pricing.db$suffix"; fi
                if [[ -e "$legacy_db$suffix" ]]; then mv -- "$legacy_db$suffix" "$pricing_db$suffix"; fi
            fi
        done
        [[ $(sqlite3 -readonly "$pricing_db" 'PRAGMA user_version;') == 0 ]] || fail 'Restored pricing DB is not legacy v0.'
        [[ $(sqlite3 -readonly "$pricing_db" 'PRAGMA integrity_check;') == ok ]] || fail 'Restored pricing DB integrity failed; service remains stopped.'
    fi
    touch "$snapshot/pricing-restored"
    printf 'Displaced pricing files retained at: %s\n' "$aside"
fi
if [[ -f "$snapshot/binary.missing" ]]; then
    rm -f -- /usr/local/bin/factory-api
else
    cp -p -- "$snapshot/binary" /usr/local/bin/factory-api
fi
if [[ -f "$snapshot/unit.missing" ]]; then
    rm -f -- /etc/systemd/system/factory-api.service
else
    cp -p -- "$snapshot/unit" /etc/systemd/system/factory-api.service
fi
systemctl daemon-reload
if [[ "$enabled" == enabled ]]; then systemctl enable factory-api.service; fi
if [[ "$active" == active ]]; then
    systemctl start factory-api.service
    deadline=$((SECONDS + 45))
    while (( SECONDS < deadline )); do
        remaining=$((deadline - SECONDS))
        (( remaining > 2 )) && remaining=2
        if sudo -u factory-api curl -fs --max-time "$remaining" -o /dev/null http://127.0.0.1:8080/v1/health; then break; fi
        if (( SECONDS < deadline )); then sleep 1; fi
    done
    sudo -u factory-api curl -fsS --max-time 2 http://127.0.0.1:8080/v1/health | jq -e '.status == "ok"' >/dev/null
    systemctl is-active --quiet factory-api.service
fi
printf '\nFactory API snapshot restored: %s\nPrior enabled state: %s; prior active state: %s (failed/unknown restored as stopped).\nPricing mode: %s; requests mode: %s; all pricing data and factory-api account preserved.\n' "$snapshot" "$enabled" "$active" "$pricing_mode" "$requests_mode"
