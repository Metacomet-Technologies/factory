# Agent contract

Work only in the assigned worktree and feature branch, never the main checkout.
Never deploy or use sudo. Never merge or use main without an explicit dispatcher
continuation. Never print or commit secrets or production data.
GitHub auth is preconfigured; never set token environment variables or run gh auth commands.

Before pushing: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
`cargo test --workspace`. Kiosk: also `vp check`, `vp test --run`, `vp build`.
Dispatcher: also `node --test scripts/dispatch` (not `node --check`).
Live checks use `scripts/sandbox`, never production; read `docs/sandbox.md` when needed.
Read `docs/agents/<area>.md` when Isolation touches that area: `db.md` for database
work (including meter/API/pricing), `kiosk.md` for kiosk.

Linear: read issues; comment/link PRs only on your issue; create related follow-ups
in Backlog. Never edit other issues or existing status, labels, assignee or priority.
Dispatcher owns control markers. Never write/delete `factory-dispatch` or
`factory-qa` markers unless explicitly authorized. Only standalone unfenced
exact-match lines count; quoted or inline markers do not.
After opening a PR and each later push, comment on your issue with only PR URL,
head SHA and complete `git diff --name-only origin/main...HEAD` file list (Markdown
list or fence). Call out deletions and renames, including sources. No diff/contents;
redact sensitive data and identify omissions.
