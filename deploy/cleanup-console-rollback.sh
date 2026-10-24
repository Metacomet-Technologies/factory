#!/usr/bin/env bash
# MET-118: remove factory-console's MET-114 rollback artifacts.
# Usage: cleanup-console-rollback.sh --dry-run|--apply|--verify
#   --dry-run  checks the gate and prints every path to archive, delete and keep.
#   --apply    takes and verifies a final archive of the old console DBs, then
#              deletes only the listed artifacts. Safe to rerun after a failure.
#   --verify   confirms the artifacts are gone and re-verifies the final archive.
# Never touches the console's MET-74 replicas, the kiosk autostart file, the Amp
# runner, the backup lock/config, or anything on factory-gpu.
set -Eeuo pipefail
shopt -s inherit_errexit
umask 0077
here=$(dirname "$(realpath "$0")")
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage='Usage: cleanup-console-rollback.sh --dry-run|--apply|--verify'
root=
if (( EUID != 0 )); then
    # Unprivileged fixture tests only: a fake root and PATH shims, no real changes.
    [[ -n ${CONSOLE_CLEANUP_TEST_ROOT:-} && -d $CONSOLE_CLEANUP_TEST_ROOT && $CONSOLE_CLEANUP_TEST_ROOT == /* && $CONSOLE_CLEANUP_TEST_ROOT != / ]] \
        || fail "Run as root: sudo bash $here/cleanup-console-rollback.sh --dry-run"
    root=$CONSOLE_CLEANUP_TEST_ROOT
else
    unset CONSOLE_CLEANUP_TEST_ROOT
    export PATH=/usr/sbin:/usr/bin:/sbin:/bin
fi
[[ $# == 1 ]] || fail "$usage"
case $1 in --dry-run) mode=dry-run ;; --apply) mode=apply ;; --verify) mode=verify ;; *) fail "$usage" ;; esac
for command in systemctl hostname tailscale getent pgrep find findmnt sqlite3 zstd sha256sum python3 flock df du stat mktemp mv rm rmdir install date env userdel groupdel grep sed awk cut sort tail; do
    command -v "$command" >/dev/null || fail "Required command missing: $command"
done
[[ $(hostname -s) == factory-console ]] || fail "This host is $(hostname -s), not factory-console; nothing changed."

# The complete MET-118 list. Nothing outside it is ever deleted.
unit=$root/etc/systemd/system/factory-api.service
unit_wants=$root/etc/systemd/system/multi-user.target.wants/factory-api.service
unit_dropins=$root/etc/systemd/system/factory-api.service.d
binary=$root/usr/local/bin/factory-api
state=$root/var/lib/factory-api
kiosk=$state/kiosk
move=$root/var/backups/factory-api-move
premove=$root/var/backups/factory-db/factory-console
# Kept: replicas are the gate evidence; the lock serializes with the backup timer.
replicas=$root/var/backups/factory-replica/factory-gpu
backup_lock=$root/var/backups/factory-db/.backup.lock
restore_check=$root/usr/local/lib/factory-backup/restore-check.sh
final=$root/var/backups/factory-met-118
archive=$final/archive
# Old console DBs: requests and pricing, plus the pre-v1 pricing file if the
# pricing installer preserved one. Each is archived before deletion.
db_files=(requests.db pricing.db pricing.v0.db)
db_names=(requests pricing pricing-v0)
state_entries=(kiosk)
for file in "${db_files[@]}"; do state_entries+=("$file" "$file-wal" "$file-shm"); done
premove_entries=(requests pricing)
kept=("$replicas" "$backup_lock" "$root/etc/factory-backup/nodes.conf" "$root/home/console/.config/autostart/console-kiosk.desktop" amp-runner.service)
# Related but outside MET-118's list: reported, never deleted.
out_of_scope=("$root/var/backups/factory-api" "$root/var/backups/factory-kiosk")

# ---------- Read-only preflight (every mode) ----------
for path in "$root/etc/systemd/system" "$root/usr/local/bin" "$root/var/lib" "$root/var/backups" "$root/var/backups/factory-db" \
    "$unit" "$unit_dropins" "$binary" "$state" "$kiosk" "$move" "$premove" "$final" "$archive"; do
    [[ ! -L $path ]] || fail "Refusing symlink: $path"
done
[[ ! -e $unit_wants ]] || fail "factory-api.service is still wanted by multi-user.target; MET-114 is not finished."
[[ ! -e $unit_dropins ]] || fail "Unexpected $unit_dropins; review it before cleanup."
enabled=$(systemctl is-enabled factory-api.service 2>/dev/null || true)
case $enabled in disabled|not-found|'') ;; *) fail "factory-api.service is $enabled; cleanup needs it disabled (MET-114 rollback in effect?)." ;; esac
active=$(systemctl is-active factory-api.service 2>/dev/null || true)
case $active in inactive|failed|unknown|'') ;; *) fail "factory-api.service is $active; cleanup needs it stopped (MET-114 rollback in effect?)." ;; esac
[[ ! -e $move/console/rolled-back ]] || fail 'MET-114 was rolled back on this console; do not clean up.'
serve=$(tailscale serve status --json 2>&1) || fail "Cannot read Tailscale Serve status: $serve"
if [[ $serve == *127.0.0.1:8080* || $serve == *localhost:8080* ]]; then
    fail 'Console Serve still proxies to the old API on :8080 (MET-114 rollback in effect?).'
fi

# Rejects anything in a listed directory that is not on the list.
unexpected() {
    local directory=$1 entry allowed
    shift
    [[ -d $directory ]] || return 0
    while IFS= read -r -d '' entry; do
        entry=${entry##*/}
        for allowed in "$@"; do [[ $entry == "$allowed" ]] && continue 2; done
        fail "Unexpected entry $directory/$entry; review it before cleanup."
    done < <(find "$directory" -mindepth 1 -maxdepth 1 -print0)
}
unexpected "$state" "${state_entries[@]}"
unexpected "$premove" "${premove_entries[@]}"
for entry in "${state_entries[@]}"; do
    [[ ! -L $state/$entry ]] || fail "Refusing symlink: $state/$entry"
done
for entry in "${premove_entries[@]}"; do
    [[ ! -L $premove/$entry ]] || fail "Refusing symlink: $premove/$entry"
done
if [[ -e $kiosk ]]; then
    [[ -z $(find "$kiosk" ! -type d ! -type f -print -quit) ]] || fail "Non-regular entry under $kiosk; review it before cleanup."
fi

# ---------- Gate: replicas of GPU's new-layout snapshots ----------
gate() {
    local name day days count
    systemctl is-active --quiet factory-backup.timer || fail 'factory-backup.timer is not active; replicas are not being kept.'
    systemctl is-active --quiet amp-runner.service || fail 'amp-runner.service is not active; investigate before cleanup.'
    for name in meter requests pricing; do
        [[ -d $replicas/$name && ! -L $replicas/$name ]] || fail "No console replica directory: $replicas/$name"
        days=()
        while IFS= read -r day; do days+=("$day"); done < <(
            find "$replicas/$name" -maxdepth 1 -type f -name '*.db.zst' -printf '%f\n' |
                sed -n 's/^\([0-9]\{8\}\)T[0-9]\{6\}\.[0-9]\{9\}Z\.db\.zst$/\1/p' | LC_ALL=C sort -u |
                awk '$1 >= "20261012"')
        count=${#days[@]}
        (( count >= 7 )) || fail "Gate: only $count daily new-layout $name replicas since 2026-10-12 (need 7): ${days[*]:-none}"
        # Every daily copy that counts toward the gate must match its checksum.
        for day in "${days[@]}"; do
            for copy in "$replicas/$name/$day"T*.db.zst; do
                (cd "$replicas/$name" && sha256sum --strict --quiet -c "${copy##*/}.sha256") \
                    || fail "Gate: replica $copy failed its checksum."
            done
        done
        printf 'Gate: %s has %d daily new-layout replicas (%s..%s), all checksums OK.\n' "$name" "$count" "${days[0]}" "${days[-1]}"
    done
    [[ -x $restore_check ]] || fail "MET-74 restore check missing: $restore_check"
    local output
    output=$("$restore_check" all 2>&1) || { printf '%s\n' "$output" >&2; fail 'Gate: restore-check.sh all failed.'; }
    printf '%s\n' "$output"
    for name in meter requests pricing; do
        [[ $output == *"factory-gpu/$name: integrity_check=ok"* ]] || fail "Gate: restore-check.sh all did not check factory-gpu/$name."
    done
    echo 'Gate: restore-check.sh all passed for the console replicas of meter, requests and pricing.'
}

# ---------- Final archive of the old console DBs ----------
# Verifies the archive (checksum, integrity, user_version, every table's row
# count) and, while a live DB remains, that the archive matches it exactly.
verify_archive() {
    local directory=$1
    shift
    python3 - "$directory" "$state" "$@" <<'PY'
import hashlib, json, pathlib, sqlite3, subprocess, sys, tempfile

directory, live_root, names = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3:]
files = dict(zip(("requests", "pricing", "pricing-v0"), ("requests.db", "pricing.db", "pricing.v0.db")))

def describe(uri):
    with sqlite3.connect(uri, uri=True) as db:
        if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise SystemExit(f"integrity_check failed: {uri}")
        tables = {}
        for (name,) in db.execute("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name"):
            quoted = '"' + name.replace('"', '""') + '"'
            tables[name] = db.execute(f"SELECT count(*) FROM {quoted}").fetchone()[0]
        return {"user_version": db.execute("PRAGMA user_version").fetchone()[0], "tables": tables}

manifest_path = directory / "counts.json"
expected = json.loads(manifest_path.read_text()) if manifest_path.exists() else None
if expected is not None and sorted(expected) != sorted(names):
    raise SystemExit(f"Archive holds {sorted(expected)}, expected {sorted(names)}")
result = {}
with tempfile.TemporaryDirectory() as temporary:
    for name in names:
        archive = directory / f"{name}.db.zst"
        sidecar = directory / f"{name}.db.zst.sha256"
        if any(p.is_symlink() or not p.is_file() for p in (archive, sidecar)):
            raise SystemExit(f"Missing or unsafe archive: {archive}")
        with archive.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        if sidecar.read_text() != f"{digest}  {archive.name}\n":
            raise SystemExit(f"Checksum mismatch: {archive}")
        copy = pathlib.Path(temporary) / f"{name}.db"
        subprocess.run(["zstd", "-q", "-d", str(archive), "-o", str(copy)], check=True)
        result[name] = describe(copy.as_uri() + "?immutable=1") | {"sha256": digest}
        copy.unlink()
        live = live_root / files[name]
        if live.is_file():
            actual = describe(live.resolve().as_uri() + "?mode=ro")
            if actual != {k: result[name][k] for k in actual}:
                raise SystemExit(f"Archive differs from live {live}: {actual}")
            print(f"{name}: archive matches live {live}")
        tables = result[name]["tables"]
        print(f"{name}: sha256 ok, integrity_check=ok, user_version={result[name]['user_version']}, "
              f"{len(tables)} tables, {sum(tables.values())} rows")
if expected is None:
    with manifest_path.open("x") as out:
        json.dump(result, out, indent=2)
        out.write("\n")
elif expected != result:
    raise SystemExit(f"Archive differs from its manifest {manifest_path}")
PY
}

live_names=()
for i in "${!db_files[@]}"; do
    if [[ -e $state/${db_files[$i]} ]]; then
        [[ -f $state/${db_files[$i]} ]] || fail "Not a regular file: $state/${db_files[$i]}"
        live_names+=("${db_names[$i]}")
    fi
done

archived_names() {
    python3 -c 'import json, sys; print(" ".join(json.load(open(sys.argv[1]))))' "$archive/counts.json"
}

take_archive() {
    if [[ -f $archive/complete ]]; then
        local names
        read -ra names <<<"$(archived_names)"
        echo "Final archive exists: $archive. Re-verifying."
        for name in "${live_names[@]}"; do
            [[ " ${names[*]} " == *" $name "* ]] || fail "Live $name DB is not in the final archive $archive; review before cleanup."
        done
        verify_archive "$archive" "${names[@]}"
        return
    fi
    [[ ! -e $archive ]] || fail "Incomplete final archive $archive; review it before rerunning."
    [[ " ${live_names[*]} " == *" requests "* && " ${live_names[*]} " == *" pricing "* ]] \
        || fail "requests.db or pricing.db is missing and no verified final archive exists; nothing deleted."
    local bytes=0 available name i stage stamp
    for i in "${!db_files[@]}"; do
        for suffix in '' -wal -shm; do
            if [[ -f $state/${db_files[$i]}$suffix ]]; then bytes=$((bytes + $(stat -c %s "$state/${db_files[$i]}$suffix"))); fi
        done
    done
    install -d -m 0700 "$final"
    available=$(df -Pk "$final" | awk 'NR==2 {print $4}')
    (( available * 1024 >= 2 * bytes + 16777216 )) || fail "Insufficient space at $final for the final archive; nothing deleted."
    find "$final" -mindepth 1 -maxdepth 1 -name 'stage.*' -exec rm -rf --one-file-system -- {} +
    stage=$(mktemp -d "$final/stage.XXXXXX")
    stamp=$(date -u +%Y%m%dT%H%M%S.%NZ)
    for i in "${!db_files[@]}"; do
        name=${db_names[$i]}
        [[ " ${live_names[*]} " == *" $name "* ]] || continue
        # The MET-74 snapshot step: SQLite .backup (WAL-aware), integrity_check, zstd, sha256.
        env -i PATH="$PATH" STAMP="$stamp" BACKUP_CONFIG="$here/backup/nodes.conf" BACKUP_HOST=factory-console \
            LOCAL_ROOT="$stage/local" BACKUP_TRANSPORT=local \
            bash "$here/backup/factory-backup.sh" --snapshot "$name" "$state/${db_files[$i]}"
        mv -- "$stage/local/factory-console/$name/$stamp.db.zst" "$stage/$name.db.zst"
        (cd "$stage" && sha256sum "$name.db.zst" > "$name.db.zst.sha256")
    done
    rm -rf --one-file-system -- "$stage/local"
    verify_archive "$stage" "${live_names[@]}"
    : > "$stage/complete"
    mv -T -- "$stage" "$archive"
    echo "Final archive verified: $archive"
}

# ---------- Deletion plan ----------
# $state holds only listed entries (checked above), so it is listed whole.
targets=()
[[ ! -e $unit ]] || targets+=("$unit")
[[ ! -e $binary ]] || targets+=("$binary")
[[ ! -e $state ]] || targets+=("$state")
[[ ! -e $move ]] || targets+=("$move")
for entry in "${premove_entries[@]}"; do [[ ! -e $premove/$entry ]] || targets+=("$premove/$entry"); done

print_plan() {
    local target
    if (( ${#targets[@]} == 0 )); then echo 'Nothing left to delete.'; return; fi
    echo 'Will delete exactly these paths (type, bytes, path):'
    for target in "${targets[@]}"; do
        find "$target" -printf '  %y %s %p\n' | LC_ALL=C sort -k3
    done
    printf 'Total: %s\n' "$(du -sch "${targets[@]}" 2>/dev/null | tail -n 1 | cut -f1)"
}

# ---------- factory-api account ----------
# Removed only if nothing else owns files as it, uses its group, or runs as it.
account_keep_reason() {
    local entry uid gid members others refs mounts owned target prune=()
    entry=$(getent passwd factory-api) || { echo absent; return; }
    uid=$(cut -d: -f3 <<<"$entry")
    gid=$(cut -d: -f4 <<<"$entry")
    (( uid != 0 )) || { echo 'factory-api is uid 0'; return; }
    if pgrep -u "$uid" >/dev/null 2>&1; then echo "processes run as factory-api: $(pgrep -u "$uid" | tr '\n' ' ')"; return; fi
    others=$(getent passwd | awk -F: -v gid="$gid" '$4 == gid && $1 != "factory-api" {print $1}')
    [[ -z $others ]] || { echo "primary group of: $others"; return; }
    members=$(getent group factory-api | cut -d: -f4 || true)
    [[ -z $members ]] || { echo "group factory-api has members: $members"; return; }
    refs=$(grep -rlE '^[[:space:]]*(User|Group|SupplementaryGroups)=.*factory-api' \
        "$root/etc/systemd/system" "$root/usr/lib/systemd/system" "$root/lib/systemd/system" 2>/dev/null |
        grep -vxF "$unit" || true)
    [[ -z $refs ]] || { echo "systemd units run as factory-api: $refs"; return; }
    # Paths this cleanup deletes do not count; anything else owned by the user or group does.
    for target in "${targets[@]}"; do prune+=(-path "$target" -o); done
    mounts=$(findmnt -rn --real -o TARGET)
    owned=$(while IFS= read -r mount; do
        mount=$root${mount%/}
        mount=${mount:-/}
        find "$mount" -xdev \( "${prune[@]}" -path /proc \) -prune -o \( -uid "$uid" -o -gid "$gid" \) -print -quit 2>/dev/null || true
    done <<<"$mounts")
    [[ -z $owned ]] || { printf 'files still owned by factory-api user or group (first per filesystem):\n%s' "$owned"; return; }
    echo remove
}

print_account() {
    local reason
    reason=$(account_keep_reason)
    case $reason in
        absent) echo 'factory-api account: already absent.' ;;
        remove) echo 'factory-api account: nothing else uses it; will remove the user and its group.' ;;
        *) printf 'factory-api account: KEEP (not removed): %s\n' "$reason" ;;
    esac
}

print_kept() {
    echo 'Never touched:'
    printf '  %s\n' "${kept[@]}" "$archive (final archive, created by --apply)" 'anything on factory-gpu'
    local path
    for path in "${out_of_scope[@]}"; do
        [[ ! -e $path ]] || printf '  %s (installer snapshots; outside MET-118 scope, %s)\n' "$path" "$(du -sh "$path" | cut -f1)"
    done
}

if [[ $mode == verify ]]; then
    for path in "$unit" "$unit_wants" "$binary" "$state" "$move"; do
        [[ ! -e $path ]] || fail "Still present: $path"
    done
    for entry in "${premove_entries[@]}"; do [[ ! -e $premove/$entry ]] || fail "Still present: $premove/$entry"; done
    [[ -z $(find "$premove" -name '*.db.zst' -print -quit 2>/dev/null) ]] || fail "Pre-move archives remain under $premove"
    [[ $(systemctl show factory-api.service --property=LoadState --value 2>/dev/null) != loaded ]] || fail 'factory-api.service is still loaded; run systemctl daemon-reload.'
    [[ -f $archive/complete ]] || fail "No complete final archive: $archive"
    read -ra names <<<"$(archived_names)"
    verify_archive "$archive" "${names[@]}"
    gate
    print_account
    echo "Verified: MET-118 rollback artifacts removed; final archive $archive verified; replicas, timer and runner OK."
    exit 0
fi

gate
echo "Archive before deletion: ${live_names[*]:-none} from $state into $archive"
print_plan
print_account
print_kept
if [[ $mode == dry-run ]]; then
    echo 'Dry run: nothing changed.'
    exit 0
fi

# ---------- Apply ----------
trap 'printf "ERROR: cleanup failed at line %s. Rerun the same --apply command; the verified archive is reused.\n" "$LINENO" >&2' ERR
[[ -f $backup_lock && ! -L $backup_lock ]] || fail "Missing or unsafe backup lock: $backup_lock"
exec 9>>"$backup_lock"
flock -n 9 || fail 'A backup or deployment is running; retry after it finishes.'
take_archive
if [[ -e $unit ]]; then
    rm -f -- "$unit"
    systemctl daemon-reload
    systemctl reset-failed factory-api.service 2>/dev/null || true
    echo "Deleted $unit"
fi
rm -f -- "$binary"
for entry in "${state_entries[@]}"; do
    if [[ -e $state/$entry ]]; then rm -rf --one-file-system -- "${state:?}/$entry"; echo "Deleted $state/$entry"; fi
done
if [[ -d $state ]]; then rmdir -- "$state"; echo "Deleted $state"; fi
if [[ -e $move ]]; then rm -rf --one-file-system -- "$move"; echo "Deleted $move"; fi
for entry in "${premove_entries[@]}"; do
    if [[ -e $premove/$entry ]]; then rm -rf --one-file-system -- "${premove:?}/$entry"; echo "Deleted $premove/$entry"; fi
done
reason=$(account_keep_reason)
if [[ $reason == remove ]]; then
    userdel factory-api
    if getent group factory-api >/dev/null; then groupdel factory-api; fi
    echo 'Removed the factory-api user and group.'
else
    print_account
fi
echo "Cleanup complete. Final archive: $archive. Run --verify next."
