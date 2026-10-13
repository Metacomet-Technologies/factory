# Account usage collector (MET-125)

Run on factory-gpu as its already authenticated `agent`. Node **24.21.0**, like
`scripts/dispatch`; no npm dependencies. No inference, login/logout, reset-credit
consumption, runner changes, settings changes, transcript reads or DB writes.

```sh
node scripts/usage/collect.ts --dry-run
node --test scripts/usage
```

The systemd oneshot polls every 15 minutes from `/home/agent/work`. Each source
runs independently with a 20-second timeout per invocation and a 2 MB stdout
ceiling. Stderr is discarded. Failures expose fixed diagnostics, never raw CLI
output or exception text. The collector kills only its own probe process group.

* **Amp:** `amp usage` each pass. `amp usage --details` attempts at most hourly,
  including failed attempts, tracked in `amp_details.attempted_at_ms`. The summary
  and two pool tables have strict label/unit/row patterns. No token, model-cost,
  daily-cost or thread tables are collected: these overlap and contain identities.
  Pool details are validated, not substituted for the net summary balances.
  Unknown shapes produce `unknown, format changed`. Fixtures use MET-121 values
  with redacted identity; pool headings were also checked on GPU on 2026-10-13.
  Supported observed shape: Gigawatt, a1.xxlarge-normalized hours. CLI version is
  recorded; the same shapes worked in `0.0.1791763306-ged595a` and
  `0.0.1791849701-g1448da`. This is the approved terminal-parsing exception,
  not a vendor JSON API. A failed hourly check keeps Amp unknown until a successful
  hourly check; a CLI update also requires a successful details check.
* **Claude:** the exact documented headless `/usage` command, pinned to 2.1.296.
  Parse only `assistant.usage_report.rate_limits`; require the final result to
  report zero turns, cost and token counts. Preserve session, weekly and known
  scoped weekly meters. Nullable resets stay null. The usage report does not
  identify Max versus Pro, so `plan` is null, not a guessed Max multiplier.
* **Codex:** pinned to 0.162.1; JSON-RPC messages include `jsonrpc: "2.0"`.
  Wait for successful id 1 `initialize`, then send `initialized` and id 2
  `account/rateLimits/read`. Keep stdin open through the id 2 response; ignore
  notifications. No other RPC methods. Use the `codex` bucket once, not the
  overlapping `rateLimitsByLimitId` copy. Reset count comes from the result's
  `rateLimitResetCredits.availableCount`, never the credit ID array.

Normal scheduled Amp usage is five account requests/hour. No thread lookups or
automatic retries. All readers share Amp's 60/hour limit. Manual dry-runs count
against that budget: they read existing scheduling metadata but **never persist
it**, so repeated dry-runs without an existing snapshot can each read details.
Do not run repeated manual probes hourly. The existing lock serializes full
runs and installation. After deployment all worktrees share the main checkout's
committed `collect.lock`; before deployment they use their local inode.

## Snapshot and API contract

`/var/lib/factory-usage/usage.json` contains `schema_version: 1`,
`generated_at_ms`, private scheduling metadata `amp_details`, and `tools`.
The API returns only `{tools}`. Entries stay ordered amp, cursor, claude-code,
codex, kimi. Existing `tool`, `status`, `note` fields remain; note is null.

Each tracked entry adds `reason`, `observed_at_ms`, `source`, `cli_version`,
nullable `plan`, `windows`, nullable `balance`, `balances`, and nullable
`reset_credits_available`. Cursor and Kimi stay `not_tracked` even when the
snapshot is missing; their added fields are null/empty.

* A successful sample is `ok`. A failure clears its values, sets `unknown` with
  a fixed reason, and retains only its last-good `observed_at_ms`. More than
  45 minutes after that reading it becomes `stale`, preserving the failure reason.
  A source that has never succeeded remains unknown. No failed reading is live.
* The API also ages successful samples on every read, so a stopped timer cannot
  leave `ok` forever. Values in these aged successful samples remain explicitly
  stale. Missing, unreadable, oversized or invalid snapshots return HTTP 200
  with unknown tracked tools and a fixed reason, never a raw error or HTTP 500.
* Balance `amount` equals `remaining`; all amount/remaining/total values are
  **decimal strings**, preserving precision without floating-point money storage.
  `balance` aliases the first member of `balances`, not an additional pool.
  `balances` resolves the ticket's singular-balance/two-Amp-pools ambiguity.
  Never sum USD, orb hours and Codex credits. Codex credits are **not USD**.
* Windows carry name, used percentage, UTC millisecond reset and nullable
  duration in minutes. Amp uses 100 minus the CLI's rounded remaining percentage;
  balances retain greater precision. Its date-only period end is represented as
  **00:00 UTC on that date**, not a verified renewal instant. Claude ISO timestamps
  and Codex epoch seconds convert to UTC milliseconds, without local timezone use.
* Reset-credit availability is a count, not a balance or USD amount. No reset
  IDs, account IDs, emails, prompts, tokens or transcripts are persisted/logged.

The collector opens a unique sibling temporary file, writes/fyncs it, then
renames it over the snapshot. No partially written snapshot becomes visible.
The service's `Group=factory-api` gives files that group; directory is
`agent:factory-api 0750`, snapshot `0640`. No group membership changes.

API flag `--usage-snapshot` / `FACTORY_API_USAGE_SNAPSHOT` defaults to this path.
Every request reads afresh. A separate task polls mtime/inode/length every 30
seconds and emits named SSE `agents.usage` with `{type, ts_ms, data: {tools}}`
on initial observation, replacement, modification or disappearance. Reconnect
clients should fetch `/v1/agents`; notifications are not replayed. The existing
API unit's `ProtectSystem=strict` permits reads; `ProtectHome=true` does not
hide `/var/lib/factory-usage`. Its `factory-api` group already has read access.

## Deploy from Mac, after merge and clean main-checkout update

Artifacts only; never run these during development. First complete the PLAYBOOK
main-checkout handoff at `/home/agent/work/factory` on factory-gpu. Then, in order:

```sh
factory-ssh 'sudo -iu agent bash -lc "cd /home/agent/work/factory && cargo build --release --locked -p factory-api"'
factory-ssh 'sudo bash /home/agent/work/factory/deploy/install-factory-api.sh /home/agent/work/factory/target/release/factory-api'
factory-ssh 'cd /tmp && sudo bash /home/agent/work/factory/deploy/install-usage.sh'
curl -fsS https://factory-gpu.bearded-pompano.ts.net/v1/agents | jq
factory-ssh 'systemctl is-active factory-usage.timer; systemctl is-enabled factory-usage.timer; systemctl list-timers factory-usage.timer'
```

The usage installer verifies all CLIs as agent from a readable directory (Node
can be a Vite+ shim), prints one sanitized dry-run and requires all three tracked
tools ok before changing anything. It snapshots units/state, sets directory
permissions, installs units, starts one collection, checks file readability as
both agent and factory-api, and requires all three tools ok through the running
API before enabling the timer. It does not redeploy API,
touch databases or restart runners. CLI authentication/refresh and service-user
permissions still require the administrator's actual installation verification.

Rollback, from Mac (substitute the exact API snapshot printed by its installer):

```sh
factory-ssh 'cd /tmp && sudo bash /home/agent/work/factory/deploy/rollback-usage.sh'
factory-ssh 'sudo bash /home/agent/work/factory/deploy/rollback-factory-api.sh /var/backups/factory-api/<printed-snapshot-directory>'
```

Usage rollback removes only collector units and retains usage.json/backups.
Without API rollback, retained usage ages stale after 45 minutes. API rollback
restores the previous API binary/unit; no usage DB migration exists.

## Checks

Fixtures reconstruct the documented Claude/Codex envelope around verified values;
they are not claimed as full original raw captures. Tests cover strict shape
rejection, independent failures, time/credit units, exact stale boundary, hourly
backoff, subprocess timeouts, fragmented RPC responses, privacy and atomic writes.
Rust exercises serialized contract, public HTTP snapshot reads and real SSE
after an atomic replacement. No tests call live vendor services.

```sh
node --test scripts/usage
UPDATE_OPENAPI=1 cargo test -p factory-api --test openapi_snapshot
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace
bash -n deploy/install-usage.sh deploy/rollback-usage.sh
shellcheck -x deploy/install-usage.sh deploy/rollback-usage.sh
```
