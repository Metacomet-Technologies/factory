#!/usr/bin/env bash
# Hash tracked build inputs, not commit identity or machine-local paths.
set -euo pipefail
export LC_ALL=C CARGO_TERM_COLOR=never
root=$(git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --show-toplevel)
python3 - "$root" "$@" <<'PY'
import hashlib
import json
from pathlib import Path
import subprocess
import re
import sys

root = Path(sys.argv[1]).resolve()
if len(sys.argv) != 3 or sys.argv[2] not in ("meter", "factory-api", "kiosk"):
    sys.exit("Usage: scripts/build-fingerprint.sh <meter|factory-api|kiosk>")
component = sys.argv[2]

def run(*args):
    return subprocess.check_output(args, cwd=root)

files = {"VERSION", "scripts/build-fingerprint.sh"}
directories = {component}
tree = b""
if component == "kiosk":
    # The Bun lockfile (bun.lock) is tracked inside kiosk/.
    files.add("factory-api/openapi.json")
else:
    # Workspace settings matter, but membership does not: adding an unrelated
    # crate must not stale this one. Its own path closure and tree are below.
    # ponytail: textual drop of the first top-level `members = [...]` (the root
    # manifest's only one); tomllib needs Python 3.11 and the sandbox CI has 3.10.
    workspace = (root / "Cargo.toml").read_bytes()
    workspace, dropped = re.subn(rb"(?ms)^members\s*=\s*\[.*?\][ \t]*\n?", b"", workspace, count=1)
    if not dropped:
        sys.exit("build-fingerprint: workspace Cargo.toml has no members list")
    metadata = json.loads(run("cargo", "metadata", "--locked", "--no-deps", "--format-version", "1"))
    packages = {p["name"]: p for p in metadata["packages"]}
    pending = [component]
    directories = set()
    while pending:
        package = packages[pending.pop()]
        directory = str(Path(package["manifest_path"]).parent.relative_to(root))
        if directory in directories:
            continue
        directories.add(directory)
        pending.extend(d["name"] for d in package["dependencies"]
                       if d.get("path") and d["kind"] != "dev")
    # Target selection and duplicate elision must not depend on the build host.
    tree = run("cargo", "tree", "-p", component, "--locked", "-e", "normal,build",
               "--target", "all", "--no-dedupe")
    tree = tree.replace(str(root).encode(), b".")

tracked = run("git", "ls-files", "-z").decode().split("\0")
files.update(p for p in tracked if p and any(p.startswith(d + "/") for d in directories))
digest = hashlib.sha256()
for name in sorted(files):
    # Length framing prevents file-boundary/content ambiguity.
    for value in (name.encode(), (root / name).read_bytes()):
        digest.update(len(value).to_bytes(8, "big"))
        digest.update(value)
if component != "kiosk":
    digest.update(len(workspace).to_bytes(8, "big"))
    digest.update(workspace)
digest.update(tree)
print(digest.hexdigest()[:12])
PY
