#!/usr/bin/env bash
# Run only in a disposable exact-SHA checkout. Never installs or deploys services.
set -euo pipefail
[[ $# == 3 && $1 =~ ^[0-9a-f]{40}$ ]] || { echo 'Usage: build.sh FULL_SHA PLAN_JSON OUTPUT_DIRECTORY' >&2; exit 1; }
root=$(realpath "$(dirname "${BASH_SOURCE[0]}")/../..")
plan=$(realpath "$2")
output=$(realpath "$3")
[[ -d $output && $(git -C "$root" rev-parse HEAD) == "$1" && -z $(git -C "$root" status --porcelain) ]] || {
    echo 'Build requires a clean checkout of the exact SHA and an existing output directory' >&2; exit 1;
}
[[ ! -e $root/.sandbox ]] || { echo 'Use a fresh disposable checkout; sandbox already exists' >&2; exit 1; }
export FACTORY_RELEASE_VERSION
FACTORY_RELEASE_VERSION=$(python3 - "$root" "$plan" "$1" <<'PY'
import json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(sys.argv[1]) / 'scripts/release'))
from release import require, version
plan = json.loads(pathlib.Path(sys.argv[2]).read_bytes())
floor = (pathlib.Path(sys.argv[1]) / 'VERSION').read_text().strip()
require(plan['source_sha'] == sys.argv[3] and plan['source_version'] == floor, 'plan/source mismatch')
require(plan['release_tag'].startswith('v') and version(plan['release_tag'][1:]) >= version(floor), 'invalid release version')
print(plan['release_tag'][1:])
PY
)
export RUSTUP_TOOLCHAIN=1.99.0 CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=4
export RUSTFLAGS="--remap-path-prefix=$root=/factory --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo"
export VITE_API_BASE=''
[[ $(rustc --version) == 'rustc 1.99.0 '* && $(rustc -vV | sed -n 's/^host: //p') == x86_64-unknown-linux-gnu ]] || {
    echo 'Release requires Rust 1.99.0 on x86_64-unknown-linux-gnu' >&2; exit 1;
}
# Resolve the runtime from the same checkout; do not mutate package manifests.
cd "$root/kiosk"
tools=$(mktemp -d "$(dirname "$output")/release-tools.XXXXXX")
trap 'rm -rf -- "$tools"' EXIT
node_version=$(node -p 'require("./package.json").devEngines.runtime.version')
bun_version=$(node -p 'require("./package.json").devEngines.packageManager.version')
[[ $node_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && $bun_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo 'Exact kiosk runtime pins required' >&2; exit 1;
}
npm install --prefix "$tools" --no-audit --no-fund "node@$node_version" "bun@$bun_version" vite-plus@1.1.0
export PATH="$tools/node_modules/.bin:$PATH"
[[ $(node --version) == "v$(node -p 'require("./package.json").devEngines.runtime.version')" ]] || {
    echo 'Activate the pinned kiosk Node runtime before building' >&2; exit 1;
}
[[ $(bun --version) == "$(node -p 'require("./package.json").devEngines.packageManager.version')" ]] || {
    echo 'Activate the pinned kiosk Bun before building' >&2; exit 1;
}
vp install --frozen-lockfile
export PATH="$root/kiosk/node_modules/.bin:$PATH"
cd "$root"
# The publisher deletes this checkout after every SHA. Keep the cargo output
# in a sibling directory and point target/ at it, so scripts/sandbox and
# package() still use target/release. The committed target/ ignore matches a
# directory, not this symlink.
cache=$(dirname "$root")/cargo-target
mkdir -p -- "$cache"
exclude=$(git -C "$root" rev-parse --git-path info/exclude)
[[ "$exclude" == /* ]] || exclude="$root/$exclude"
mkdir -p -- "$(dirname "$exclude")"
if [[ ! -f "$exclude" ]] || ! grep -qxF /target "$exclude"; then
    printf '%s\n' /target >> "$exclude"
fi
[[ ! -e "$root/target" && ! -L "$root/target" ]] || { echo 'Release checkout target already exists' >&2; exit 1; }
ln -s -- "$cache" "$root/target"
trap '[[ -L "$root/target" ]] && rm -f -- "$root/target"; rm -rf -- "$tools"' EXIT
cargo build --release --locked -p meter -p factory-api -p pricing -p factory-ups-control -p sandbox
trap 'scripts/sandbox down; [[ -L "$root/target" ]] && rm -f -- "$root/target"; rm -rf -- "$tools"' EXIT
if ! scripts/sandbox up --rows 1k --kiosk; then
    for service in runtime seed meter factory-api; do scripts/sandbox logs "$service" || true; done
    exit 1
fi
# CI already ran smoke.py for this SHA. package() reads the live health endpoints.
python3 scripts/release/release.py package --root "$root" --plan-file "$plan" --directory "$output"
[[ -z $(git status --porcelain) ]] || { echo 'Build dirtied source' >&2; exit 1; }
