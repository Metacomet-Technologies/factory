Main-based development: commit to `main` and push. Use a worktree off
`origin/main` for anything longer than one sitting; rebase, never merge.
Never print/commit secrets or production data.
Auth works; never set token environment variables or run gh auth commands.

Before pushing: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
`cargo test --workspace`. Kiosk: `vp check`, `vp test --run`, `vp build`.
Scripts: `node --test scripts/usage` (never `node --check`), `bash deploy/lint-installers.sh`.
Run only the checks for what you changed; CI runs everything on every push to main.
Fix a red main before anything else.
Live checks: `scripts/sandbox` (`docs/sandbox.md`), never production.
Read `docs/agents/<area>.md` when you touch it: `db.md` for DB work
(incl. meter/API/pricing), `kiosk.md` for kiosk, `cloud.md`.

Deploy on factory-gpu, after your commit is on `origin/main`:
`sudo factory-deploy meter factory-api kiosk` (any subset; see
`deploy/sudoers/README.md`). That is the only sudo you may use. Every other
installer (backup, alerts, usage, devices, ups, pricing, reboot), DB migrations
and anything on factory-console stay with Devon: write the command, don't run it.

Linear is an issue tracker: read issues, comment on the ones you work on, put
the commit SHA in your comment, and create follow-ups in Backlog. Never edit
other issues' status, labels, assignee or priority.
