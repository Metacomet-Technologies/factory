# Account usage collector (MET-125)

Run on factory-gpu as its already authenticated `agent`. Node **24.22.1** in
`.node-version` remains the preferred and CI version; runtime accepts Node 24.x at
**24.12.0** or newer. No npm dependencies, inference, login/logout, reset-credit
consumption, runner changes, settings changes, transcript reads or DB writes.

## Kiosk-triggered refresh (MET-139)

`POST /v1/agents/refresh` atomically replaces
`/var/lib/factory-usage-trigger/request` with the accepted UTC millisecond timestamp.
The API serializes requests and enforces 180 seconds after the later of that
timestamp (preserved across restarts) and a valid snapshot's `generated_at_ms`.
It returns 202 with `status: "accepted"` and `next_allowed_at_ms`, or 429 with
`error.code: "cooldown"`, that deadline and rounded-up `Retry-After` seconds.
Nonempty bodies return 400, bodies over 1024 bytes return 413, cross-site browser
submissions return 403, and trigger failures return 500 `trigger_write_failed`.
`--usage-trigger` / `FACTORY_API_USAGE_TRIGGER` overrides the path for isolated tests.

Root's `factory-usage-refresh.path` watches `PathChanged=` and starts the existing
agent-owned collector service; API never invokes CLIs or sudo. Systemd coalesces
starts while that service is running. SSE still observes snapshots every 30 seconds;
202 means requested, not completed. The API installer creates the private
`factory-api:factory-api 0700` trigger directory before restarting its hardened unit;
the usage installer preserves its inode and enables/verifies the path unit.
Usage rollback disables/removes the path and timer/service but retains snapshots
and the trigger directory.

```sh
node scripts/usage/collect.ts --dry-run
node --test scripts/usage
```

The systemd oneshot polls every 15 minutes from `/home/agent/work`. Each source
runs independently with a 20-second timeout per invocation and a 2 MB stdout
ceiling. Stderr is discarded. Failures expose fixed diagnostics, never raw CLI
output or exception text. The collector kills only its own probe process group.

* **Amp:** `amp usage` each pass. `amp usage --details` attempts at most hourly,
  except that a CLI version change triggers immediate validation. Every attempt,
  including a forced or failed one, restarts the hourly backoff tracked in
  `amp_details.attempted_at_ms`. The summary
  and two pool tables have strict label/unit/row patterns. No token, model-cost,
  daily-cost or thread tables are collected: these overlap and contain identities.
  Pool details are validated, not substituted for the net summary balances.
  Unknown shapes produce status `unknown` with reason `format changed`.
  Fixtures use MET-121 values with redacted identity; pool headings were also
  checked on GPU on 2026-10-13.
  Supported observed shape: Gigawatt, a1.xxlarge-normalized hours. CLI version is
  recorded; the same shapes worked in `0.0.1791763306-ged595a` and
  `0.0.1791849701-g1448da`. Version `0.0.1791864325-g52e626` (2026-10-13)
  emits a plain summary with workspace balances; details retain Markdown. Version
  `0.0.1792108872-gab0eb7` (2026-10-16) may append the exact optional Individual
  credits note ` (set up auto-reload to avoid running out)`.
  Version `0.0.1795305655-gf675ab` (2026-11-22) reports the Megawatt tier with
  hours normalized to `a1.small`. The tier is accepted as any one capitalized
  word and the size as any `a1.<size>`, in the summary and the orb pool header.
  A pool with no draw yet has only its All sources row.
  Both summary styles accept an optional `a1.<size>` label and either
  `resets in N days` or `resets upon renewal in N days`. Sign-in identities are
  discarded. Workspace USD balances carry `label: "workspace <name>"` and
  `total: null`; unknown lines, duplicate pools and mismatched workspace URLs
  fail closed. This is the approved terminal-parsing exception,
  not a vendor JSON API. A failed hourly check keeps Amp unknown until a successful
  hourly check; a CLI update also requires a successful details check.
* **Claude:** the exact documented headless `/usage` command.
  Parse only `assistant.usage_report.rate_limits`; require the final result to
  report zero turns, cost and token counts. Preserve session, weekly and known
  scoped weekly meters. Nullable resets stay null. The usage report does not
  identify Max versus Pro, so `plan` is null, not a guessed Max multiplier.
* **Cursor:** `agent about --format json`. Record the plan only. There is no
  headless usage command; interactive `/usage` is not scraped and dashboard
  tokens are not extracted. Both a null email and a null tier mean
  `not logged in`. An email with a null tier is `CLI failed`. Plans map
  case-insensitively, with an optional `Cursor ` prefix: free, pro,
  `Pro Plus`/`pro+` → `pro_plus`, premium (seen on CLI `2026.11.19-f005e9d`), ultra, team/teams, business, enterprise, edu.
  Email, request id, OS and terminal fields are dropped. An ok row has a plan
  and empty windows. Version shape is `YYYY.M.D-<hex>`, checked on CLI
  `2026.10.16-e3cb207`. A live signed-in `subscriptionTier` of `Ultra` maps
  to `ultra`; the address was present and is not stored. The committed
  signed-in fixture remains synthetic Pro.
* **Kimi Code:** there is no `kimi usage` subcommand in 2.2.0. If
  `127.0.0.1` and `FACTORY_KIMI_PORT` (default 58627) are already accepting
  connections, `GET /api/v1/oauth/usage` uses the existing local server and
  does not stop it. Otherwise the collector starts `kimi web --no-open --port`
  with stdout discarded (the banner prints the bearer token), reads
  `$KIMI_CODE_HOME/server.token` or `~/.kimi-code/server.token`, then kills
  only that process group. The token file must be a regular non-symlink file,
  mode `0600`, owned by the collector user, and a 16–128 character token.
  The request stays on `127.0.0.1`, does not follow redirects, and caps the
  body at 64 KiB. `limit5h` → `five_hour` (300), `limit7d` → `weekly`
  (10080), `monthTotal` → `monthly`. `monthCode` is checked and not stored.
  A USD `extraUsage` wallet becomes one balance from cent integers; other
  currencies are omitted, never converted. The logged-out body
  `No token for "kimi-code". Run /login to authenticate.` is `not logged in`
  and the message is not stored. A live logged-in probe returned HTTP 200,
  `code` 0, `msg` `success`, `kind` `ok`, usage keys `limit5h` and `limit7d`
  only, and `currency` null, so that account has two windows and no wallet.
  `monthTotal` stays optional. The ratios from that probe were not printed;
  the USD and monthly fixtures remain synthetic. Cent fields with a null
  currency are `format changed`, not a dropped wallet.
* **OpenCode:** local session cost, not account remaining. Only the cost is
  stored, as USD `label: "session cost"` with `total: null` and `amount`
  equal to `remaining`. Version `1.19.3` uses `opencode stats` with no flags.
  The two box tables must be present in order. Session, message and token
  lines are shape checks and are not stored. An optional tool-usage box is
  accepted and ignored. A model box or any other extra line is
  `format changed`. Version `opencode v2.0.32` is recorded as `2.0.32` and
  probed with `opencode stats --all --cost` (35s, because that CLI waits up
  to 30s for its local server). The default share card, including
  `no activity in this range`, has no cost and is `format changed`. The v2
  text must be the plain `all time · all projects` cost block, with two
  spaces before each row. A live empty account printed `$0.00` and is stored
  as session cost `0.00`. Token rows are checked and dropped. `--json`,
  `--models`, `--tools` and `--full` are not used, so model and tool names
  are not read. ANSI or an extra section is `format changed`.
* **Codex:** JSON-RPC messages include `jsonrpc: "2.0"`.
  Wait for successful id 1 `initialize`, then send `initialized` and id 2
  `account/rateLimits/read`. Keep stdin open through the id 2 response; ignore
  notifications. No other RPC methods. Use the `codex` bucket once, not the
  overlapping `rateLimitsByLimitId` copy. Reset count comes from the result's
  `rateLimitResetCredits.availableCount`, never the credit ID array.

Claude and Codex version strings are strictly parsed and recorded, not pinned.
New versions with unchanged output remain supported; output-format changes
produce status `unknown` with reason `format changed`.

Normal scheduled Amp usage is five account requests/hour. No thread lookups or
automatic retries. A CLI update adds a details request to that pass (at most
eight account requests/hour with an update on every scheduled pass), counted
within the shared 60/hour budget, not exempt from it. All readers share Amp's
60/hour limit. Manual dry-runs count
against that budget: they read existing scheduling metadata but **never persist
it**, so repeated dry-runs without an existing snapshot can each read details.
Do not run repeated manual probes hourly. The existing lock serializes full
runs and installation. After deployment all worktrees share the main checkout's
committed `collect.lock`; before deployment they use their local inode.

## Snapshot and API contract

`/var/lib/factory-usage/usage.json` contains `schema_version: 1`,
`generated_at_ms`, private scheduling metadata `amp_details`, and `tools`.
The API returns only `{tools}`. Entries stay ordered amp, cursor, claude-code,
codex, kimi, opencode. Existing `tool`, `status`, `note` fields remain; note is null.

`FACTORY_USAGE_SNAPSHOT` overrides the collector's snapshot path for both reads
and writes, including scheduling reads during `--dry-run`. The production default
is unchanged. Tests always use temporary paths; no test reads or writes `/var/lib`.
The parent directory must already exist. CI runs the suite with the pinned
Node 24.22.1 runtime: `node --test scripts/usage`.

Each tracked entry adds `reason`, `observed_at_ms`, `source`, `cli_version`,
nullable `plan`, `windows`, nullable `balance`, `balances`, and nullable
`reset_credits_available`. All six tools are tracked. A missing or invalid
snapshot marks every tool `unknown`; `not_tracked` is no longer emitted.

* A successful sample is `ok`. A failure clears its values, sets `unknown` with
  a fixed reason, and retains only its last-good `observed_at_ms`. More than
  45 minutes after that reading it becomes `stale`, preserving the failure reason.
  Parse failures report `format changed`, timed-out probes report `timeout`,
  and missing executables report `CLI missing`. Older scheduling diagnostics
  remain readable and normalize to the new wording on the next collection.
  A source that has never succeeded remains unknown. No failed reading is live.
* The API also ages successful samples on every read, so a stopped timer cannot
  leave `ok` forever. Values in these aged successful samples remain explicitly
  stale. Missing, unreadable, oversized or invalid snapshots return HTTP 200
  with unknown tracked tools and a fixed reason, never a raw error or HTTP 500.
* Balance `amount` equals `remaining`; all amount/remaining/total values are
  **decimal strings**, preserving precision without floating-point money storage.
  `balance` aliases the first member of `balances`, not an additional pool.
  `balances` resolves the ticket's singular-balance/two-Amp-pools ambiguity.
  The additive nullable `label` identifies workspace pools or OpenCode's
  exact `session cost`; older snapshots may omit it. Labels are bounded
  workspace slugs or that one session-cost label, not sign-in identities.
  Amp has at most eight balances, including its two unlabeled summary pools;
  additional balances must be unique workspace USD pools with no total.
  Workspace slugs are 1–63 lowercase ASCII letters/digits/hyphens and start
  with a letter or digit. OpenCode's only balance is unlabeled except for
  `session cost` and has no total. Other tools retain the two-balance limit.
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
The service keeps agent's default primary group and adds
`SupplementaryGroups=factory-api`. The setgid directory is
`agent:factory-api 2750`, so temporary files inherit `factory-api`; atomic
replacement preserves that group and snapshot mode `0640`. No account group
membership changes.

API flag `--usage-snapshot` / `FACTORY_API_USAGE_SNAPSHOT` defaults to this path.
Every request reads afresh. A separate task polls mtime/inode/length every 30
seconds and emits named SSE `agents.usage` with `{type, ts_ms, data: {tools}}`
on initial observation, replacement, modification or disappearance. Reconnect
clients should fetch `/v1/agents`; notifications are not replayed. The existing
API unit's `ProtectSystem=strict` permits reads; `ProtectHome=true` does not
hide `/var/lib/factory-usage`. Its `factory-api` group already has read access.

## Install and rollback (Devon)

factory-api deploys automatically from green main. Devon installs the collector
units on factory-gpu from his Mac, and rolls them back the same way:

```sh
gpu-ssh 'sudo bash /home/agent/work/factory/deploy/install-usage.sh'
gpu-ssh 'sudo bash /home/agent/work/factory/deploy/rollback-usage.sh'
```

The installer runs one sanitized dry run as agent and requires amp, cursor,
claude-code, codex, kimi and opencode `ok` before changing anything; it does not
log in. It snapshots units and state, installs the units, starts one collection
and requires all six tools `ok` through the running API before enabling the
timer. Rollback removes only the collector units and keeps `usage.json` and its
backups; retained usage goes stale after 45 minutes.

## Checks

Fixtures reconstruct the documented Claude/Codex envelope around verified values;
they are not claimed as full original raw captures. Tests cover strict shape
rejection, independent failures, time/credit units, exact stale boundary, hourly
backoff, subprocess timeouts, fragmented RPC responses, privacy and atomic writes.
The MET-137 summary preserves the supplied quota text with only the identity
redacted; its details fixture reconstructs the observed Markdown/report layout.
Rust exercises serialized contract, public HTTP snapshot reads and real SSE
after an atomic replacement. No tests call live vendor services.

Run `scripts/check` before pushing. It runs the usage group
(`node --test scripts/usage`) for changes here, and the rust and shell groups
when those files change. Regenerate the OpenAPI snapshot after a contract change
with `UPDATE_OPENAPI=1 cargo test -p factory-api --test openapi_snapshot`.
