#!/usr/bin/env bash
# Deploy origin/main to factory-gpu: sudo factory-deploy <meter|factory-api|kiosk>...
# Root-owned copy at /usr/local/sbin/factory-deploy; the one agent sudo rule is
# deploy/sudoers/factory-agent-deploy. It fast-forwards the main checkout, builds
# as agent, runs the component's installer, then requires three health probes at
# the new SHA and rolls back to the installer's snapshot otherwise.
# The installers come from the agent-writable checkout, so this rule trusts agent
# with root on factory-gpu by design.
set -Eeuo pipefail
checkout=/home/agent/work/factory
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
as_agent() { runuser -u agent -- env -i HOME=/home/agent USER=agent \
    PATH=/home/agent/.local/share/vite-plus/bin:/home/agent/.cargo/bin:/usr/local/bin:/usr/bin:/bin "$@"; }

[[ $EUID -eq 0 ]] || fail 'Run with sudo: sudo factory-deploy <meter|factory-api|kiosk>...'
[[ $(hostname -s) == factory-gpu ]] || fail 'Deploy only on factory-gpu.'
(( $# > 0 )) || fail 'Usage: factory-deploy <meter|factory-api|kiosk>...'
for component in "$@"; do
    case $component in meter|factory-api|kiosk) ;; *) fail "Unknown component: $component" ;; esac
done
exec 9>/run/factory-deploy.lock
flock -n 9 || fail 'Another deploy is running.'

cd "$checkout"
[[ -z $(as_agent git status --porcelain --untracked-files=no) ]] || fail "$checkout has local changes."
as_agent git fetch --quiet origin main
as_agent git checkout --quiet main
as_agent git merge --quiet --ff-only origin/main
sha=$(as_agent git rev-parse HEAD)
printf 'Deploying %s at %s\n' "$*" "$sha"

health() {
    case $1 in
        meter) curl -fsS -m 5 http://127.0.0.1:11434/meter/health ;;
        factory-api) curl -fsS -m 5 http://127.0.0.1:8080/v1/health ;;
        kiosk) curl -fsS -m 5 http://127.0.0.1:8080/version.json ;;
    esac
}
healthy_at() {
    local probe
    for _ in 1 2 3; do
        sleep 20
        probe=$(health "$1" 2>/dev/null) || return 1
        python3 -c 'import json,sys; d=json.loads(sys.argv[1]); g=d.get("git_sha") or ""; sys.exit(not (len(g)>=7 and sys.argv[2].startswith(g) and d.get("git_dirty") is False))' \
            "$probe" "$2" || return 1
    done
}

for component in "$@"; do
    case $component in
        meter)
            as_agent cargo build --release --locked -p meter
            installer=(deploy/install-meter.sh --no-db-change target/release/meter)
            rollback=(deploy/rollback-meter-v1.sh) ;;
        factory-api)
            as_agent cargo build --release --locked -p factory-api
            installer=(deploy/install-factory-api.sh target/release/factory-api)
            rollback=(deploy/rollback-factory-api.sh) ;;
        kiosk)
            (cd kiosk && as_agent vp install --frozen-lockfile && as_agent vp build)
            installer=(deploy/install-kiosk.sh kiosk/dist)
            rollback=(deploy/install-kiosk.sh --rollback) ;;
    esac
    log=$(mktemp)
    if bash "${installer[@]}" 2>&1 | tee "$log"; then
        healthy_at "$component" "$sha" && { printf '%s healthy at %s\n' "$component" "$sha"; rm -f "$log"; continue; }
        printf '%s failed its health probes at %s\n' "$component" "$sha" >&2
    fi
    # Installers print their snapshot on success ("Rollback snapshot:") and in their failure hint.
    snapshot=$(grep -oE '/var/backups/(meter|factory-api|factory-kiosk)/[0-9]{8}T[0-9]{6}\.[0-9]+Z\.[A-Za-z0-9]+' "$log" | tail -1 || true)
    rm -f "$log"
    [[ -n $snapshot ]] || fail "$component install failed before taking a snapshot; nothing to roll back."
    printf 'Rolling back %s to %s\n' "$component" "$snapshot" >&2
    bash "${rollback[@]}" "$snapshot"
    fail "$component rolled back; later components were not deployed."
done
