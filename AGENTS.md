# Agent contract

Work only in the assigned worktree and feature branch, never the main checkout.
Never deploy or use sudo, even `sudo -u agent`: you already run as `agent`. Never
merge or use main without an explicit dispatcher
continuation. Never print or commit secrets or production data.
GitHub auth is preconfigured; never set token environment variables or run gh auth commands.

Before pushing: `scripts/env/check` (`docs/environments.md`), `cargo fmt --check`,
`cargo clippy --all-targets -- -D warnings`, `cargo test --workspace`.
Kiosk: `vp check`, `vp test --run`, `vp build`.
Dispatcher: `node --test scripts/dispatch` (not `--check`).
Live checks: `scripts/sandbox`, never production.
Read `docs/agents/<area>.md` when Isolation touches it: `db.md` for DB work
(incl. meter/API/pricing), `kiosk.md` for kiosk, `cloud.md`.

Linear: comment/link PRs only on your issue; create related follow-ups in
Backlog. Never edit other issues or existing status, labels, assignee or priority.
Dispatcher owns control markers. Never write/delete `factory-dispatch` or
`factory-qa` markers unless explicitly authorized. Only standalone unfenced
exact-match lines count; quoted or inline markers do not.
After opening a PR and each later push, comment on your issue with only PR URL,
head SHA and complete `git diff --name-only origin/main...HEAD` file list (Markdown
list or fence). Call out deletions and renames, including sources. No diff/contents;
redact sensitive data and identify omissions.
