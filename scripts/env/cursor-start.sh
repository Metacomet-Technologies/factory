#!/usr/bin/env bash
# Per-boot: refresh the snapshot checkout to current main, then start the synthetic stack.
# Exits after the sandbox is ready; services stay up.
set -euo pipefail
cd /workspace

# 1. Fast-forward a stale snapshot to origin/main. Never touches agent commits or edits.
if git fetch --quiet origin main; then
  if git merge-base --is-ancestor HEAD origin/main && git diff --quiet && git diff --cached --quiet; then
    git merge --ff-only --quiet origin/main
  fi
else
  echo "start: WARNING git fetch failed; checkout may be stale" >&2
fi
echo "start: HEAD $(git rev-parse --short HEAD), origin/main $(git rev-parse --short origin/main)"

# 2. Synthetic stack (capture, then test: no grep -q under pipefail).
status=$(scripts/sandbox status 2>&1 || true)
if [[ $(head -n 1 <<<"$status") == 'Sandbox running' ]]; then
  printf '%s\n' "$status"
  exit 0
fi
if ! scripts/sandbox up --rows 1k --kiosk; then
  echo "start: WARNING sandbox up failed; agent can run 'scripts/sandbox up' itself" >&2
fi
