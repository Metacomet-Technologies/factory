Main-based development: commit to `main` and push. Use a worktree off
`origin/main` for anything longer than one sitting; rebase, never merge.
Never print/commit secrets or production data.
Auth works; never set token environment variables or run gh auth commands.

`scripts/check` runs the check groups your change touches (`--list` shows
them, `--all` runs everything); `--fast` runs only the static checks (format,
lint, types) in seconds. The pre-push hook runs `--fast`; enable it once per
clone: `git config core.hooksPath .githooks`. Run the full `scripts/check` for
the tests you want before pushing; CI runs `scripts/check --all` on every push
to main, `ci-ok` is the one green/red check, and only green commits deploy.
Fix a red main before anything else.
Live checks: `scripts/sandbox` (`docs/sandbox.md`), never production.
Read `docs/agents/<area>.md` when you touch it: `db.md` for DB work
(incl. meter/API/pricing), `kiosk.md` for kiosk, `cloud.md`.

Deploys are automatic: `factory-autodeploy.timer` deploys meter, factory-api
and kiosk within minutes of `ci-ok` going green, only the ones whose build
inputs changed (`deploy/autodeploy.sh`; status in
`/var/lib/factory-autodeploy/status.json`, failures alert in Slack). Do not
deploy by hand unless it is down; then `sudo factory-deploy <component>...` on
factory-gpu (`deploy/sudoers/README.md`). That is the only sudo you may use. Every other
installer (backup, alerts, usage, devices, ups, pricing, reboot), DB migrations
and anything on factory-console stay with Devon: write the command, don't run it.

Linear is an issue tracker: read issues, comment on the ones you work on, put
the commit SHA in your comment, and create follow-ups in Backlog. Never edit
other issues' status, labels, assignee or priority.
