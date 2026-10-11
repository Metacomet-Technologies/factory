#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 || ! $1 =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
    echo 'Usage: scripts/bump-version.sh X.Y.Z (no leading zeroes, prerelease or build suffix)' >&2
    exit 1
fi
version=$1
root=$(git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --show-toplevel)
cd "$root"
if [[ -n $(git status --porcelain --untracked-files=all) ]]; then
    echo 'Refusing to bump version: working tree must be clean (including untracked files).' >&2
    exit 1
fi

python3 - "$version" <<'PY'
import json
from pathlib import Path
import re
import sys
import tomllib

version = sys.argv[1]
manifest = Path("Cargo.toml")
text = manifest.read_text()
old = tomllib.loads(text)["workspace"]["package"]["version"]
text, count = re.subn(
    r'(\[workspace\.package\]\s*\n(?:[^\[]*?\n)?version\s*=\s*")' + re.escape(old) + r'(")',
    lambda match: match[1] + version + match[2],
    text,
    count=1,
)
if count != 1 or tomllib.loads(text)["workspace"]["package"]["version"] != version:
    raise SystemExit("Could not locate workspace.package.version in Cargo.toml")
package = Path("kiosk/package.json")
data = json.loads(package.read_text())
data["version"] = version
manifest.write_text(text)
package.write_text(json.dumps(data, indent=2) + "\n")
Path("VERSION").write_text(version + "\n")
PY

cargo update --workspace
cargo test -p factory-api --test contract repo_versions_match_single_source --locked
# utoipa embeds the package version in OpenAPI info.version.
UPDATE_OPENAPI=1 cargo test -p factory-api --test openapi_snapshot --locked
printf '\nVersion %s is ready for review. Next steps:\n' "$version"
printf '1. Open a PR with VERSION, Cargo.toml, Cargo.lock, kiosk/package.json and factory-api/openapi.json.\n'
printf '2. Merge the PR after its checks pass.\n'
printf '3. From your Mac: gh release create v%s --repo Metacomet-Technologies/factory --target main --generate-notes\n' "$version"
