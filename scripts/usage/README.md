# Account usage collector (MET-125)

Run on factory-gpu as its already authenticated `agent`. Node **24.21.0** in
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
After the clean merged build, install API, run
`gpu-ssh 'cd /tmp && sudo bash /home/agent/work/factory/deploy/install-usage.sh'`,
then build/install kiosk. Usage rollback disables/removes the path and timer/service
but retains snapshots and the trigger directory. Restore kiosk and API using their
printed installer snapshots; no database migration or Ollama restart is required.

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
  Both summary styles accept an optional `a1.xxlarge` size label and either
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
* **Cursor:** `agent about --format json` records the plan. The CLI has no
  headless usage command (Teams spend comes from the Admin API below);
  interactive `/usage` is not scraped and dashboard tokens are not extracted. Both a null email and a null tier mean
  `not logged in`. An email with a null tier is `CLI failed`. Plans map
  case-insensitively, with an optional `Cursor ` prefix: free, pro,
  `Pro Plus`/`pro+` → `pro_plus`, ultra, team/teams, business, enterprise, edu.
  Email, request id, OS and terminal fields are dropped. An ok row has a plan
  and empty windows. Version shape is `YYYY.M.D-<hex>`, checked on CLI
  `2026.10.16-e3cb207`. A live signed-in `subscriptionTier` of `Ultra` maps
  to `ultra`; the address was present and is not stored. The committed
  signed-in fixture remains synthetic Pro.
* **Cursor Teams spend (MET-221):** with an Admin API key at
  `/etc/factory-usage/cursor-admin-key`, the Cursor row adds Teams cycle spend
  from `https://api.cursor.com`. No key keeps the plan-only row above. The file
  must be a regular non-symlink, non-empty (at most 1024 bytes), owned by root,
  group the collector's group (`agent`) and mode exactly `0640`. It is opened
  with `O_NOFOLLOW | O_NONBLOCK` and validated from that descriptor, so a FIFO
  or other non-regular file fails only the Cursor row (`CLI failed`) at once,
  without waiting for a writer. The key is sent only as Basic auth and never
  logged or stored. At most one Admin fetch per hour in total, whatever the key
  file, including failures (`cursor_admin.attempted_at_ms`); runs between
  fetches reuse the cached aggregate, and `observed_at_ms` is the fetch time.
  The cache records which key file it came from (device, inode, size and mtime
  as `cursor_admin.key_id`, never the key). Inside the hour, a different key
  file (a replaced key, or identical bytes in a new inode) does not fetch and
  does not reuse that cache: the row stays plan-only until the next hourly
  fetch, which uses the current key. A removed key keeps the hour's attempt;
  after the hour it clears the cache.
  A fetch reads every `POST /teams/spend` page (3.1 s apart, under 20/min) and
  every `POST /teams/filtered-usage-events` page (1000 events, 1.05 s apart,
  under 60/min) from `subscriptionCycleStart` to now, in inclusive ranges of
  at most 30 days. A 120-second wall-clock budget bounds the whole fetch, and
  each request has a hard deadline (at most 20 s) even while bytes keep
  arriving; expiry reports `timeout` for Cursor only. Pagination must agree:
  `currentPage`, constant `numPages`/`totalPages` and totals, `hasNextPage`
  exactly when pages remain, and summed events/members equal to the reported
  totals. Every event needs `chargedCents`; token-based events
  (`isTokenBasedCall`) need all four `tokenUsage` counts, while request-based
  events may omit `tokenUsage`. Mapping:
  * `plan`: the `agent about` tier (`Teams` → `team`).
  * one USD balance, label `cycle spend`, `total` null: the sum of members'
    `spendCents` (on-demand spend). Names, emails and user IDs are dropped.
  * a `monthly` window only when every member has an enforced
    `effectivePerUserLimitDollars`. Its limit is their sum, `used_percent` is
    spend over that limit (capped at 100), and `resets_at_ms` is the next cycle
    start (same UTC day next month, clamped to month end). No window otherwise.
  * `breakdown`, at most 20 USD items from summed `chargedCents`: `headless`
    (`isHeadless`, such as cloud agents), `interactive`, then models by spend.
    Model labels are lowercased with other characters replaced by `-`; past 17
    models the tail folds into `other models`.
  * Private `cursor_admin.data` also keeps `maxUserSpendCents`,
    `limitedUsersCount`, and per model × headless event counts, `chargedCents`
    and token sums. The API does not serve them. `requestsCosts` is weighted
    billing units and is not summed as a request count.
  401 or 403 makes the row `unknown` with reason `admin key rejected` and keeps
  the plan. Any other HTTP status, timeout or unexpected shape fails closed for
  the Cursor row only. After the cached cycle ends, the row shows the plan only
  until the next hourly fetch. Per-agent cloud usage
  (`GET /v1/agents/{id}/usage`) is MET-216's, not this collector's.
  Fetches stay at most hourly, so the API marks the row stale between 45 and
  60 minutes after each fetch. `FACTORY_CURSOR_ADMIN_KEY_FILE` and a loopback
  `FACTORY_CURSOR_API_BASE` (`http://127.0.0.1:<port>`) exist for tests and
  sandbox checks only.
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
The parent directory must already exist. CI runs both Node suites with the pinned
Node 24.21.0 runtime: `node --test scripts/dispatch scripts/usage`.

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

## Deploy from Mac, after merge and clean main-checkout update

Artifacts only; never run these during development. First complete the PLAYBOOK
main-checkout handoff at `/home/agent/work/factory` on factory-gpu. Then, in order:

```sh
gpu-ssh 'sudo -iu agent bash -lc "cd /home/agent/work/factory && cargo build --release --locked -p factory-api"'
gpu-ssh 'sudo bash /home/agent/work/factory/deploy/install-factory-api.sh /home/agent/work/factory/target/release/factory-api'
gpu-ssh 'cd /tmp && sudo bash /home/agent/work/factory/deploy/install-usage.sh'
curl -fsS https://factory-gpu.bearded-pompano.ts.net/v1/agents | jq
gpu-ssh 'systemctl is-active factory-usage.timer; systemctl is-enabled factory-usage.timer; systemctl list-timers factory-usage.timer'
```

The usage installer verifies all CLIs as agent from a readable directory (Node
can be a Vite+ shim), prints one sanitized dry-run and requires amp, cursor,
claude-code, codex, kimi and opencode `ok` before changing anything. Cursor
must already be logged in with a recognized plan, and Kimi must already be
logged in; the installer does not log in. It snapshots units/state, sets directory
permissions, installs units, starts one collection, checks file readability as
both agent and factory-api, and requires those six tools ok through the running
API before enabling the timer. Install the API before this collector: a
five-tool snapshot does not validate on the six-tool API, and the previous API
rejects the six-tool snapshot. It does not redeploy API,
touch databases or restart runners. CLI authentication/refresh and service-user
permissions still require the administrator's actual installation verification.

Rollback, from Mac (substitute the exact API snapshot printed by its installer):

```sh
gpu-ssh 'cd /tmp && sudo bash /home/agent/work/factory/deploy/rollback-usage.sh'
gpu-ssh 'sudo bash /home/agent/work/factory/deploy/rollback-factory-api.sh /var/backups/factory-api/<printed-snapshot-directory>'
```

Usage rollback removes only collector units and retains usage.json/backups.
Without API rollback, retained usage ages stale after 45 minutes. API rollback
restores the previous API binary/unit; no usage DB migration exists.

## MET-137 upgrade and rollback (from Mac)

Devon merges this self-deploying change; the wrap-up pull updates the collector
in `/home/agent/work/factory`. Do not reinstall its unchanged timer/service.
Until the API upgrade, the old API rejects the extra workspace balance or new
diagnostic strings. After the clean main-checkout handoff, install in this order:

```sh
gpu-ssh 'sudo -iu agent bash -lc "cd /home/agent/work/factory && cargo build --release --locked -p factory-api"'
gpu-ssh 'sudo bash /home/agent/work/factory/deploy/install-factory-api.sh /home/agent/work/factory/target/release/factory-api'
gpu-ssh 'sudo -iu agent bash -lc "cd /home/agent/work/factory/kiosk && vp install --frozen-lockfile && VITE_API_BASE= vp build"'
gpu-ssh 'sudo bash /home/agent/work/factory/deploy/install-kiosk.sh /home/agent/work/factory/kiosk/dist'
gpu-ssh 'sudo -iu agent bash -lc "cd /home/agent/work/factory && node scripts/usage/collect.ts --dry-run"'
curl -fsS https://factory-gpu.bearded-pompano.ts.net/v1/agents | jq '.tools[] | select(.tool == "amp")'
```

Wait for the next scheduled collection (up to 15 minutes, or the next hourly
details attempt after a failed check) before verifying the API row is live.
UI only: inspect Frontier CLIs on the console kiosk after its self-reload.
No console install, inference, migration or Ollama restart is needed.

For rollback, first merge a reviewed revert PR and complete its wrap-up pull
to restore the collector; do not reset main or restore the old API while the
new collector keeps writing unsupported balances. Then restore the exact
snapshots printed by the installers, in reverse order:

```sh
gpu-ssh 'sudo bash /home/agent/work/factory/deploy/rollback-kiosk.sh /var/backups/factory-kiosk/<printed-kiosk-snapshot>'
gpu-ssh 'sudo bash /home/agent/work/factory/deploy/rollback-factory-api.sh /var/backups/factory-api/<printed-api-snapshot>'
```

The prior collector cannot parse this CLI format, so rollback restores the
previous stale/unknown behavior rather than making Amp live.

## MET-142 upgrade and rollback (from Mac)

Devon merges this self-deploying change. The wrap-up pull updates the collector
in `/home/agent/work/factory`; CI uses the new Node test step on merge. No unit
reinstall, service restart, console change, migration or deploy artifact is needed.
After the wrap-up handoff, verify once:

```sh
gpu-ssh 'sudo -iu agent bash -lc "cd /home/agent/work/factory && node scripts/usage/collect.ts --dry-run"'
```

Rollback requires a reviewed revert PR and its wrap-up pull, not a reset of main.
After that handoff, run the same command above. This restores the old hourly
CLI-version mismatch behavior; snapshots and units remain unchanged.

## MET-221 Cursor admin key (from Mac)

After merge and the clean main-checkout handoff, install the key through stdin
(never argv). Preflight reports the key as present or absent with owner and mode,
and never fails when it is absent. The installer stages the key at
`root:agent 0640` beside the final path and runs its dry-run with it. The
staged key is installed only if that preflight made a fresh, successful Admin
fetch. Because the hourly budget is shared by every key file, a preflight within
an hour of the last attempt defers: the installer prints when to retry and
exits. A deferred, rejected or failed result leaves the installed key unchanged
and removes the staged file; cached success from another key never validates
it. On success the installer hands that preflight snapshot to the first
collection, which reuses its fetch (same key file inode) rather than fetching
again:

```sh
op read 'op://Factory/Cursor admin API key/credential' | gpu-ssh 'cd /tmp && sudo bash /home/agent/work/factory/deploy/install-usage.sh --cursor-admin-key-stdin'
gpu-ssh 'sudo systemctl start factory-usage.service'
curl -fsS https://factory-gpu.bearded-pompano.ts.net/v1/agents | jq '.tools[] | select(.tool == "cursor")'
```

Installing makes one Admin fetch in total; the manual collection above reuses it
within the hour. The first install has no earlier attempt and never defers. To
replace an installed key, first stop the timer and refresh path so no
collection takes the next hourly fetch, then rerun the installer at or after
the printed retry time; it re-enables both:

```sh
gpu-ssh 'sudo systemctl stop factory-usage.timer factory-usage-refresh.path'
```

Without `--cursor-admin-key-stdin`, an already installed key is reported and
used as is, and its preflight snapshot is handed off the same way.
Rollback keeps the key unless asked:
`gpu-ssh 'cd /tmp && sudo bash /home/agent/work/factory/deploy/rollback-usage.sh --remove-cursor-admin-key'`.
To return to plan-only without removing units, delete only
`/etc/factory-usage/cursor-admin-key`; the row is plan-only from the next run,
and the cache clears once its hour has passed.

## Checks

Fixtures reconstruct the documented Claude/Codex envelope around verified values;
they are not claimed as full original raw captures. Tests cover strict shape
rejection, independent failures, time/credit units, exact stale boundary, hourly
backoff, subprocess timeouts, fragmented RPC responses, privacy and atomic writes.
The MET-137 summary preserves the supplied quota text with only the identity
redacted; its details fixture reconstructs the observed Markdown/report layout.
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
