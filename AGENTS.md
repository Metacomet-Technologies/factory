Work only in the assigned worktree and feature branch, never the main checkout.
Never deploy or use sudo, even `sudo -u agent`; you are `agent`. Never merge or
use main without an explicit dispatcher continuation. Never print/commit
secrets or production data.
Auth works; never set token environment variables or run gh auth commands.

Before pushing: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
`cargo test --workspace`. Kiosk: `vp check`, `vp test --run`, `vp build`.
Dispatcher: `node --test scripts/dispatch`, not `node --check`.
Before reporting tests: `scripts/env/check --env <name>` (`docs/environments.md`).
Live checks: `scripts/sandbox` (`docs/sandbox.md`), never production.
Read `docs/agents/<area>.md` if Isolation touches it: `db.md` for DB work
(incl. meter/API/pricing), `kiosk.md` for kiosk, `cloud.md`.
Orchestrator only: `docs/agents/orchestrator.md`.

Linear: read issues; comment/link PRs only on your issue; create related
follow-ups in Backlog. Never edit other issues or existing status, labels, assignee or priority.
Never write/delete `factory-dispatch` or `factory-qa` markers unless explicitly
authorized. Only standalone unfenced exact-match lines count.
After opening a PR and each later push, comment on your issue with only PR URL,
head SHA and complete `git diff --name-only origin/main...HEAD` file list
(Markdown list/fence). Call out deletions and renames, including sources.
No diff/contents; redact sensitive data and identify omissions.
