# Agent sandbox (MET-93 v1)

One worktree, one private synthetic stack. No deployments, live databases, GPU
inference, host Tailscale, or production requests. The existing kiosk mock is
still useful for UI-only fixtures; this sandbox runs the real meter and API.

## Usage

Requires Linux, Rust/Cargo, a C compiler, Python 3.11+, Bash, util-linux `flock`,
and working Bubblewrap (`bwrap`) network/PID namespaces. No sudo is used.
Install missing host prerequisites through an administrator; startup fails
closed if namespaces are unavailable. Optional kiosk builds require the pinned
Vite+ toolchain described in `kiosk/README.md`.

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
options fail. Use `reset` to change seed/row count. `reset` accepts the same options as `up`, including `--kiosk`; omitted
options return to defaults. `up` on a running sandbox fails instead of spawning
duplicates. Row counts accept integers or `k`, with a 1,000,000-row ceiling.

## Ports and isolation

SHA-256 of the absolute, resolved worktree path selects a base port:
`20000 + first_four_bytes_as_big_endian_integer % 9997`. Fake Ollama uses the
base, meter base+1, and factory-api/kiosk base+2. All listeners use 127.0.0.1.
Startup reserves all three host ports and fails clearly on collision. Different
paths normally yield different ports; a hash collision needs another worktree
path, not silently selected ephemeral ports. `status` prints URLs and
`.sandbox/ports.json` records the mapping.

For a remote runner, open these URLs through your existing SSH tunnel; they are
not reachable directly from another machine. No firewall or Tailscale changes
are made. The API serves the built kiosk at `/`; without `--kiosk`, it serves its
existing placeholder.

The three services share a private Bubblewrap network namespace with only
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

## Limits and follow-up hooks

- Factory-api has no CLI/environment feed URL override or pricing collector
  disable flag. v1 leaves pricing unconfigured/unconfirmed, does not seed its DB,
  and blocks its attempted public refresh inside the namespace. Pricing warnings
  and null spend are expected. Add those configuration hooks before connecting
  the fake feeds through the real refresh path; do not alter production defaults.
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
health, usage, GPU and SSE checks, then always stops it. It does not change the
required `rust`, `kiosk`, or `scripts` checks or branch protection.

v2 may publish sanitized real-data snapshots using consistent SQLite backups,
explicit approval, a versioned manifest (schema, timestamp, counts, checksums),
access controls and a documented redaction/retention policy. Import must verify
checksums/schema into disposable local files, never overwrite live databases,
and retain synthetic-only offline fallback. No snapshot collection, publication,
credentials, production access or snapshot import is implemented in v1.
