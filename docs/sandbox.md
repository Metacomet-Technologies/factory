# Agent sandbox (MET-93 v1)

One worktree, one private synthetic stack. No deployments, live databases, GPU
inference, host Tailscale, or production requests. The existing kiosk mock is
still useful for UI-only fixtures; this sandbox runs the real meter and API.

## Usage

Requires Linux, Rust/Cargo, a C compiler, Python 3.10+, Bash, util-linux `flock`,
and working Bubblewrap (`bwrap`) network/PID namespaces. No sudo is used.
Install missing host prerequisites through an administrator; startup fails
closed if namespaces are unavailable. Optional kiosk builds require the pinned
Vite+ toolchain described in `kiosk/README.md`.

Ubuntu 24.04's AppArmor policy can reject Bubblewrap loopback setup. The sandbox
never disables that policy or falls back to host networking. The separate CI job
uses Ubuntu 22.04; the required jobs keep their existing Ubuntu 24.04 runners.

```sh
scripts/sandbox up --rows 100k --seed 42 --kiosk
scripts/sandbox status
python3 scripts/sandbox-shims/smoke.py --kiosk
scripts/sandbox logs factory-api
scripts/sandbox down
scripts/sandbox reset --rows 1k   # deletes only this worktree's sandbox state
scripts/sandbox down
```

`up` builds release binaries and, with `--kiosk`, installs dependencies and builds
the kiosk. **Build-time dependency downloads can use the internet. Runtime cannot.**
All runtime state (databases, logs, ports, pidfiles, sockets and seed metadata)
lives under `.sandbox/`, with owner-only permissions. Build products remain in
the normal ignored `target/` and `kiosk/dist/` directories.

`down` preserves data. The next `up` with matching seed/rows reuses it; mismatched
options fail. Use `reset` to change seed/row count. `reset` accepts the same
options as `up`, including `--kiosk`; omitted options return to defaults. `up` on
a running sandbox fails instead of spawning duplicates. Row counts accept
integers or `k`, with a 1,000,000-row ceiling.

## Ports and isolation

SHA-256 of the absolute, resolved worktree path selects a base port:
`20000 + first_four_bytes_as_big_endian_integer % 9997`. Fake Ollama uses the
base, meter base+1, factory-api/kiosk base+2, and fake Serve base+3.
All listeners use 127.0.0.1. Startup reserves all four host ports and fails clearly
on collision. Different
paths normally yield different ports; a hash collision needs another worktree
path, not silently selected ephemeral ports. `status` prints URLs and
`.sandbox/ports.json` records the mapping.

For a remote runner, open these URLs through your existing SSH tunnel; they are
not reachable directly from another machine. No firewall or Tailscale changes
are made. The API serves the built kiosk at `/`; without `--kiosk`, it serves its
existing placeholder.

The services share a private Bubblewrap network namespace with only
loopback. Fixed-destination Python stdlib relays bridge each host loopback port
through a Unix socket into that namespace. Relays do not accept arbitrary
destinations. Host ports 11434/11435 are unreachable from inside, and no external
route exists. Startup tests those denials and saves `.sandbox/isolation.json`.
The host filesystem is read-only except `.sandbox`; `/run`, `/tmp`, `/dev` and
`/proc` are private mounts. Runtime starts with an empty environment, without
tokens, inherited proxies or application settings. This is isolation for trusted
development binaries, not a hostile-code execution service.

`runtime.pid` includes PID and Linux process start time. `down` validates that
identity and uses a pidfd, never a name/port-wide kill. The supervisor owns the
namespace; exiting it tears down its children. Per-service `*.namespace-pid`
files are diagnostic namespace-local PIDs, **not host PIDs to kill**. Concurrent
commands use an exclusive directory lock. Startup failures stop their namespace;
failed seeds require `reset`, rather than appending to a partial database.

## Fakes and deterministic data

`fake-ollama --port N --seed N` binds loopback and implements `/api/version`,
`/api/ps`, `/api/tags`, `/api/chat`, `/api/generate`, and
`/v1/chat/completions`. Chat/generate default to NDJSON; OpenAI defaults to JSON.
Explicit `stream` supports JSON and NDJSON/SSE respectively. The final frames
include Ollama token counts/nanosecond durations or OpenAI `usage`; SSE ends
with `[DONE]`. All three factory presets (also `:latest`) are accepted.
OpenAI requests with tools return the first tool name and synthetic `{}` arguments;
this is transport testing, not schema-aware tool planning or real inference.

A fixed FNV-1a hash of seed, endpoint and canonical JSON determines response text,
counts and reported timings. Identical requests are byte-identical; measured
wall latency and background traffic are not deterministic. Request headers:

- `X-Fake-Delay-Ms: 80`: delay before response, bounded to 0–60000 ms.
- `X-Fake-Error: 500`: HTTP failure, bounded to 400–599.
- `X-Fake-Disconnect: 1`: stream one frame, then terminate the body with an error.

`/feeds/openrouter` and `/feeds/litellm` return static, synthetic reference rates
in the real parsers' formats. Contract tests run both parsers against the feeds.
These are fixtures, not current provider prices.

`sandbox-seed --db-path NEW.db --seed 42 --rows 100000 --days 30` uses meter's
existing public `Db`/`Event` writer. **No meter exports, copied insert SQL or
copied schema are needed.** A transaction and queue barriers make large seeds
bounded and surface writer errors. Three fixture-only `DELETE ... RETURNING`
statements through `Db::query` create ID gaps at 7, 31 and 97 when the row count
allows; extra inserted rows preserve the requested final count. These explicit
table references will need updating if meter renames its tables.

Rows cover synthetic hostnames `dgarbs51-synthetic` and `david-synthetic`, all
presets, non-model endpoints, HTTP errors, disconnects, null tokens and 20-row
bursts separated by quiet periods. One GPU sample per 100 requests passes through
meter's own seven-day pruning. Request rows are identical for the same seed,
rows, days and `--end-ms`. The CLI defaults to fixed epoch 1791676800000;
the launcher supplies the current UTC midnight and records it in `seed.json`
so requests appear in current usage ranges. GPU retention follows wall time,
so the retained GPU subset changes when replaying old fixtures later.
Reopening a seed database is refused; repeated `up` does not reseed it.

The `nvidia-smi` shim supplies GPU 0, 9255/12288 MiB, 65% utilization, 62 °C and
135.5 W. The `tailscale` shim reports only the synthetic sandbox node, including
minimal `whois` JSON. A `timedatectl` shim returns `yes` for the exact NTP check
so synthetic ingestion can run; it does not assert host clock synchronization.
Background traffic sends one request every two seconds through meter. API SSE
and the kiosk ticker advance on the existing 30-second sync cadence.

## UPS fake (MET-162)

The namespace also runs `fake-upsd` on its private `127.0.0.1:3493`; the API's
`FACTORY_API_UPS_ADDR` points there, never at the host's NUT service. No host
port or relay to upsd is added. It supports `VER`, `LIST VAR cyberpower`, and `LOGOUT`
with the real variable names and synthetic values. Set this worktree's mode:

```sh
printf '%s\n' 'OL' > .sandbox/ups-status
printf '%s\n' 'OB DISCHRG' > .sandbox/ups-status
printf '%s\n' 'OB DISCHRG LB' > .sandbox/ups-status
printf '%s\n' 'ERR DATA-STALE' > .sandbox/ups-status
```

The file defaults to `OL` on first startup and survives `down`/`up`.
Each read consults it; any other content returns `ERR DATA-STALE`.
`GET /v1/ups` reads immediately; `ups.sample` updates every 10 seconds.
Use `scripts/sandbox logs fake-upsd` for protocol server failures.

### UPS control and fake Serve (MET-166)

The namespace also runs `factory-ups-control` on private port 8090, using only
synthetic credentials under `.sandbox/credentials`, its own `.sandbox/ups-control.db`,
and the private fake upsd. Fake Serve at base+3 strips `/control` and injects the
login from `.sandbox/serve-login`; it never trusts HTTP identity headers. Set that
file to `DGarbs51@github`, `metacometdave@github`, an unlisted login, or `tagged`
(no identity header). Its local Slack sink writes only message JSON, never the
authorization header, to `.sandbox/slack-posts.jsonl`.

Startup first runs the **production default trusted UID 0** configuration on 8090
and sends an allowed-but-forged identity as the sandbox user. It requires 403 and
saves `.sandbox/ups-guard-check.json`. It then stops that process and runs the same
binary trusting the sandbox user's UID for fake Serve. This is deliberately a
two-phase test: a same-UID direct caller is indistinguishable from fake Serve in
the second phase. It does not claim otherwise or weaken the production default.

Fake upsd additionally supports USERNAME/PASSWORD, INSTCMD, SET VAR, LIST ENUM,
LIST RANGE, LIST CMD/RW, SET TRACKING ON, GET TRACKING and FSD. It advertises the
real command/variable set, enforces the control user's instant-command allowlist,
and records received lines in `.sandbox/ups-received.log`, masking PASSWORD.
FSD only acknowledges the fake latch; it cannot shut down any host.

Optional fixture files: `.sandbox/ups-values.json` overrides variable values;
`.sandbox/ups-ranges.json` maps variables to arrays of `[min,max]` ranges.
`.sandbox/ups-tracking` selects `SUCCESS` (default), `FAILURE`, `PENDING`, or
`PLAIN_OK` (missing tracking receipt). A SET changes the fake value only after
tracking SUCCESS. These controls are local files, not remotely exposed APIs.

Run once on fresh synthetic state (a second run correctly meets cooldown/pending
refusals; reset only disposable sandbox data if another clean run is needed):

```sh
scripts/sandbox up --rows 1k
python3 scripts/sandbox-shims/ups-smoke.py
python3 scripts/sandbox-shims/smoke.py
scripts/sandbox down
```

The UPS check prints state, the saved direct-guard 403, unlisted/tagged 403s,
request/confirm quick test and sensitivity change, OB power refusal, FSD acknowledgement,
the received mutation/tracking lines and all audit rows. Evidence is also saved
at `.sandbox/ups-check.json`. No screenshots, real credentials, physical outlet
changes, production Serve or live NUT calls occur.

The API's usage snapshot and refresh trigger also point inside `.sandbox`.
Without a synthetic `.sandbox/usage.json`, Frontier CLIs show unknown usage;
the sandbox never displays the host's account quota snapshot.

## Pricing hooks (MET-111)

`up` passes `--openrouter-feed-url` and `--litellm-feed-url` pointing to the
fake's `/feeds/openrouter` and `/feeds/litellm`, plus `--disable-pricing-collector`.
It calls the real `POST /v1/pricing/refresh`, then
`POST /v1/pricing/confirm/{family}` for both pending families. Reused databases
retain already-confirmed selections. No pricing SQL is seeded. Both families
use synthetic rates of $2 input / $10 output per million tokens.
Responses and refresh/confirm timing are saved in `.sandbox/pricing-check.json`.

Run the existing check without kiosk builds:

```sh
scripts/sandbox up --rows 1k
python3 scripts/sandbox-shims/smoke.py
scripts/sandbox down
```

The check waits at most 120 seconds for ingestion, asserts positive dated `usd`
spend avoided for **each** family after synthetic requests, and prints pricing
responses, rates, usage timings, spend and namespace isolation evidence as JSON.
Pre-history seeded requests may have separate `estimated_usd` spend; the assertion
requires post-confirmation spend, not only estimates.
Clock guards remain active. The existing exact-command `timedatectl` shim supplies
the synthetic clock assertion; a clock warning fails pricing setup, never bypasses it.
Production feed defaults and automatic collection remain unchanged when hooks
are unset. No installer/unit change or production deployment is needed for this check.

## Limits and follow-up hooks

- Factory-api's clock requirement has no synthetic/offline CLI clock hook; the
  exact-command shim is sufficient for v1, but not proof of production NTP.
- Meter's writer and seven-day GPU pruning own the current legacy schema. This
  intentionally creates fixtures for later meter migration tests, not an alternate
  database implementation. Seeded errors are facts; fault headers test real proxy
  error/disconnect behavior separately.
- No LLM quality, real GPU throughput, Tailscale policy, physical kiosk, production
  migration, or real-data privacy behavior is verified by this stack.

## Checks and v2

`cargo test -p sandbox` tests protocol determinism, real meter parsing of JSON,
NDJSON and SSE, tool calls, faults, feed parsing, seed counts/gaps and nullable
fields. Run workspace fmt/clippy/tests too. Check Bash scripts with `bash -n`
and `shellcheck -x`. The separate CI `sandbox` job runs a 1k-row stack and public
health, pricing, positive spend-avoided, usage, GPU and SSE checks, then always
stops it. It does not change the required `rust`, `kiosk`, or `scripts` checks
or branch protection.

v2 may publish sanitized real-data snapshots using consistent SQLite backups,
explicit approval, a versioned manifest (schema, timestamp, counts, checksums),
access controls and a documented redaction/retention policy. Import must verify
checksums/schema into disposable local files, never overwrite live databases,
and retain synthetic-only offline fallback. No snapshot collection, publication,
credentials, production access or snapshot import is implemented in v1.
