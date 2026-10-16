# Agent contract

Work only in the assigned worktree and feature branch, never the main checkout.
Never deploy or use sudo, even `sudo -u agent`: you already run as `agent`. Never
merge or use main without an explicit dispatcher
continuation. Never print or commit secrets or production data.
GitHub auth is preconfigured; never set token environment variables or run gh auth commands.

Before pushing: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
`cargo test --workspace`. Kiosk: also `vp check`, `vp test --run`, `vp build`.
Dispatcher: also `node --test scripts/dispatch` (not `node --check`).
Live checks: `scripts/sandbox` (see `docs/sandbox.md`), never production.
Read `docs/agents/<area>.md` when Isolation touches it: `db.md` for DB work
(incl. meter/API/pricing), `kiosk.md` for kiosk.

Linear: read issues; comment/link PRs only on your issue; create related follow-ups
in Backlog. Never edit other issues or existing status, labels, assignee or priority.
Dispatcher owns control markers. Never write/delete `factory-dispatch` or
`factory-qa` markers unless explicitly authorized. Only standalone unfenced
exact-match lines count; quoted or inline markers do not.
After opening a PR and each later push, comment on your issue with only PR URL,
head SHA and complete `git diff --name-only origin/main...HEAD` file list (Markdown
list or fence). Call out deletions and renames, including sources. No diff/contents;
redact sensitive data and identify omissions.

## Cursor Cloud specific instructions

Boot runs `scripts/sandbox up --rows 1k --kiosk` when that synthetic stack is
stopped, then returns. `scripts/sandbox status` prints the loopback URLs.
`scripts/sandbox down` stops it. The stack stays inside Bubblewrap and does not
call production.

Login shells prepend Node 24.21.0 and a `vp` wrapper. Inside `kiosk/`, `vp`
is the project CLI. From `kiosk/`: `OPENAPI_URL=file://$PWD/../factory-api/openapi.json vp check`,
then `vp test --run` and `VITE_API_BASE= vp build`.

`verify-kiosk` expects `/home/agent/work/factory` and
`/home/agent/.config/vite-plus/env`. Those are a symlink to this checkout and a
PATH file. Playwright browsers are in `kiosk/.browsers`.
