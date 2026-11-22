#!/usr/bin/env bash
# Continuous deploy for factory-gpu, run as agent by factory-autodeploy.timer.
# Picks the newest commit on origin/main whose ci-ok check passed (main's tip is
# often still in CI when pushes are frequent), back to the commit the checkout
# was last deployed at. It deploys every component whose build inputs differ
# from what is running: each one's health reports inputs_fingerprint, compared
# with scripts/build-fingerprint.sh at that commit. Deploying goes through the
# one agent sudo rule, factory-deploy --at <commit>, which builds exactly that
# commit, installs, probes health and rolls back. A failed commit is never
# retried; a newer green one is. The status file feeds the deploy:* alerts.
set -Eeuo pipefail
checkout=${FACTORY_CHECKOUT:-/home/agent/work/factory}
state=${STATE_DIRECTORY:-/var/lib/factory-autodeploy}
repo=${FACTORY_REPO:-Metacomet-Technologies/factory}
deploy=${FACTORY_DEPLOY:-/usr/local/sbin/factory-deploy}
lock=${FACTORY_DEPLOY_LOCK:-/run/factory-deploy.lock}
fingerprint=${FACTORY_FINGERPRINT:-scripts/build-fingerprint.sh}
failure=$state/failure.json

# Writes status.json atomically: when main was last checked, its CI result and
# the outstanding deploy failure, if any.
write_status() {
    python3 - "$state/status.json" "$1" "$2" "$failure" <<'PY'
import json, os, sys, time
path, sha, ci, failure = sys.argv[1:]
try:
    with open(failure) as f:
        deploy_failure = json.load(f)
except FileNotFoundError:
    deploy_failure = None
status = {"checked_at_ms": int(time.time() * 1000), "main_sha": sha, "ci": ci,
          "deploy_failure": deploy_failure}
with open(path + ".tmp", "w") as f:
    json.dump(status, f)
    f.write("\n")
os.chmod(path + ".tmp", 0o644)
os.replace(path + ".tmp", path)
PY
}

running_fingerprint() {
    local url
    case $1 in
        meter) url=http://127.0.0.1:11434/meter/health ;;
        factory-api) url=http://127.0.0.1:8080/v1/health ;;
        kiosk) url=http://127.0.0.1:8080/version.json ;;
    esac
    curl -fsS -m 5 "$url" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("inputs_fingerprint") or "")' 2>/dev/null || true
}

ci_of() {
    local conclusion
    conclusion=$(gh api "repos/$repo/commits/$1/check-runs?check_name=ci-ok" \
        --jq '[.check_runs[] | .conclusion // "pending"] | first // "pending"')
    case $conclusion in
        success) echo success ;;
        pending|neutral|skipped) echo pending ;;
        *) echo failure ;;
    esac
}

cd "$checkout"
git fetch --quiet origin main
head=$(git rev-parse origin/main)
deployed=$(git rev-parse HEAD)
ci=$(ci_of "$head")
sha=
for commit in $(git rev-list --first-parent --max-count=30 origin/main); do
    if [[ $commit == "$head" ]]; then result=$ci; else result=$(ci_of "$commit"); fi
    if [[ $result == success ]]; then sha=$commit; break; fi
    [[ $commit != "$deployed" ]] || break
done
if [[ -z $sha ]]; then
    write_status "$head" "$ci"
    echo "main $head: CI $ci; no newer green commit to deploy"
    exit 0
fi

tree=$(mktemp -d)
trap 'git worktree remove --force "$tree/tree" >/dev/null 2>&1 || true; rm -rf "$tree"' EXIT
git worktree add --quiet --detach "$tree/tree" "$sha"
components=()
for component in meter factory-api kiosk; do
    want=$("$tree/tree/$fingerprint" "$component")
    have=$(running_fingerprint "$component")
    if [[ $want != "$have" ]]; then
        components+=("$component")
        echo "$component: running ${have:-unknown}, main $want"
    fi
done

if ((${#components[@]} == 0)); then
    rm -f "$failure"
    write_status "$head" "$ci"
    echo "$sha: production is current"
    exit 0
fi
if [[ -f $failure ]] && python3 -c 'import json,sys; sys.exit(json.load(open(sys.argv[1]))["sha"] != sys.argv[2])' "$failure" "$sha"; then
    write_status "$head" "$ci"
    echo "$sha already failed to deploy; waiting for a newer green commit"
    exit 0
fi
# A manual deploy holds the lock; try again next tick rather than record a failure.
if [[ -e $lock ]] && ! flock -n "$lock" true; then
    write_status "$head" "$ci"
    echo 'Another deploy is running; retrying next tick'
    exit 0
fi

log=$tree/deploy.log
echo "Deploying ${components[*]} at $sha"
if sudo -n "$deploy" --at "$sha" "${components[@]}" 2>&1 | tee "$log"; then
    rm -f "$failure"
else
    detail=$(grep -E '^ERROR: ' "$log" | tail -1 | cut -c8-200 || true)
    python3 - "$failure" "$sha" "${detail:-factory-deploy failed}" "${components[@]}" <<'PY'
import json, sys
path, sha, detail, *components = sys.argv[1:]
with open(path, "w") as f:
    json.dump({"sha": sha, "components": components, "detail": detail}, f)
PY
fi
write_status "$head" "$ci"
