# factory: meter

`meter` is a transparent Ollama metering proxy for factory-gpu. It forwards
all non-`/meter/*` paths (including NDJSON, OpenAI SSE, embeddings, and unknown
future Ollama endpoints), records usage in SQLite, and samples NVIDIA GPUs.
The workspace contains `shared` (serde/utoipa API contract), `meter`
(axum/Tokio/Hyper binary), and `pricing` (reference rates and spend-avoided
estimates). Meter contains no pricing logic; factory-api is not built yet.

## Build identity (MET-107 phase 1)

The root `VERSION` file is the single source of truth, initially `0.2.0`.
All Rust crates inherit the matching workspace version; `kiosk/package.json`
must match too. `cargo test --workspace` checks all manifests. Rust and kiosk
builds reject their manifest version if it disagrees with `VERSION`.
This repo-wide 0.x SemVer is independent of the API's `/v1` contract version.

Both health endpoints report `version`, short `git_sha`, `git_dirty`, and
`built_at_ms` (Unix milliseconds). Rust embeds these through `shared/build.rs`;
the kiosk embeds the same fields through its Vite configuration. Cargo refreshes
identity on every build, including unstaged edits and commits without source
changes. Build from the same clean commit on both nodes. Untracked, non-ignored
files count as dirty. Without Git or `.git`, SHA is `unknown` and dirty is false;
this does not certify a clean source tree.

Fleet's `meter-http` and `factory-api` HTTP entries expose these fields where
their health responses provide them. Legacy health responses remain healthy
with null identity fields. Other checks do not invent build identities.
The kiosk's fixed footer stays visible while scrolling at phone/tablet sizes.
It shows the repo version and each component's SHA, warns separately about
version/SHA mismatches, dirty builds, and incomplete identities, and exposes
per-component versions and build times in native title text. Unknown is not
proof of either a match or a mismatch. Fleet also displays known service versions.
Desktop pricing notices use two columns and Fleet fills available columns to
keep the 1728×1117 dashboard above the footer without page scrolling for the
current live data and normal fixtures; arbitrarily larger data can still scroll.

Regenerate kiosk types against an isolated updated API, without weakening the
live contract gate:

```sh
# From kiosk/, while the isolated API listens on :18080:
OPENAPI_URL=http://127.0.0.1:18080/openapi.json vp run api:types
OPENAPI_URL=http://127.0.0.1:18080/openapi.json vp check
vp test --run
vp build
```

### Releases

Releases are manual; there is no release bot or CHANGELOG file.

1. In a clean feature branch, run `scripts/bump-version.sh 0.2.1` and open a PR.
   It updates `VERSION`, both manifests, workspace entries in `Cargo.lock`, and
   the OpenAPI snapshot's embedded version, then checks version consistency.
   Use a 0.x version; the script never commits, pushes, or tags.
2. Merge the bump PR after the `rust`, `kiosk`, and `scripts` CI checks pass.
3. From your Mac, publish the matching release:
   `gh release create v0.2.1 --repo Metacomet-Technologies/factory --target main --generate-notes`.

The release workflow checks that the existing tag exactly matches `v$(cat VERSION)`
at its commit, uses 0.x SemVer, and belongs to `main`'s history. It reruns CI on
that verified commit and never edits or deletes the release. For a post-merge
dry run against an existing tag, use
`gh workflow run release.yml --repo Metacomet-Technologies/factory -f tag=v0.2.0`.
Artifacts and version-downloading installers remain MET-107 phase 3.

CI uses `factory-api/openapi.json` without a running API. Its drift test checks
the public OpenAPI endpoint; regenerate intentional schema changes with
`UPDATE_OPENAPI=1 cargo test -p factory-api --test openapi_snapshot`, then update
kiosk types against that file. Normal kiosk development retains its live schema gate.

### Phase 1 deployment after merge (administrator handoff)

Do not run these during development. On each node, use the same merged commit
in a clean `/home/agent/work/factory` checkout as `agent`, never build with sudo.
Update the checkout using the repository's authenticated Git workflow first.
The meter installer stops meter for migration; it restarts Ollama only if its
`OLLAMA_HOST` drop-in changes. An unchanged drop-in leaves Ollama running.
The API installer restarts factory-api; kiosk installation only replaces static
files, without restarting either service.

On **factory-gpu**, as `agent`:

```sh
cargo build --release --locked -p meter
sudo bash /home/agent/work/factory/deploy/install-meter.sh /home/agent/work/factory/target/release/meter
```

On **factory-console**, as `agent`, build/install the API before the kiosk so
the strict schema check uses the updated contract:

```sh
cargo build --release --locked -p factory-api
sudo bash /home/agent/work/factory/deploy/install-factory-api.sh /home/agent/work/factory/target/release/factory-api
cd /home/agent/work/factory/kiosk
source /home/agent/.config/vite-plus/env
vp install --frozen-lockfile
OPENAPI_URL=http://127.0.0.1:8080/openapi.json vp check
vp test --run
VITE_API_BASE= vp build
sudo bash /home/agent/work/factory/deploy/install-kiosk.sh /home/agent/work/factory/kiosk/dist
```

Verify `/meter/health` on factory-gpu:11434, `/v1/health` and `/v1/fleet` on
factory-console:8080, and the visible kiosk footer. All three should show the
same version/SHA and clean builds; build times need not match.

## Run without changing Ollama

Requires Rust/Cargo, a C compiler (bundled SQLite), `nvidia-smi`, and `tailscale`.
Create the database parent directory first. For example:

```sh
cargo build --release --locked -p meter
target/release/meter migrate --db /tmp/meter-check.db
target/release/meter --listen 127.0.0.1:11500 \
  --upstream http://127.0.0.1:11434 --db-path /tmp/meter-check.db
curl http://127.0.0.1:11500/api/version
curl http://127.0.0.1:11500/meter/health
```

Configuration (CLI flags override environment variables):

- `--listen` / `METER_LISTEN`: `0.0.0.0:11434`.
- `--upstream` / `METER_UPSTREAM`: `http://127.0.0.1:11435`, HTTP origin only.
- `--db-path` / `METER_DB_PATH`: `/srv/factory/meter/meter.db`.
- `--gpu-sample-interval` / `METER_GPU_SAMPLE_INTERVAL`: `15`, seconds, positive integer.
- `RUST_LOG`: tracing filter, default `meter=info`.

Request and response frames pass through as received; parsing inspects a copy,
without collecting the response before forwarding. Status, header values,
bodies, and trailers are preserved; HTTP wire framing, header casing/order,
and TCP chunk boundaries are not part of the HTTP application contract.
There is no automatic decompression, retry, usage injection, or stream timeout.
Upload bodies also stream upstream. JSON request metadata and non-streaming
usage responses are copied in memory for parsing; NDJSON/SSE parsing retains
only the current unfinished line. Prompts and generated text are not persisted.

Each forwarded request produces one row on completion or disconnect, including
non-generation paths and upstream connection failures (502). `/meter/*` calls
are not metered, so polling does not inflate usage. Native generation defaults
to streaming; OpenAI defaults to non-streaming. Explicit request `stream`
overrides the default. Missing usage/token counts remain null, not zero;
OpenAI's entire `usage` object is retained when present. No request is modified
to ask upstream for usage. Error JSON or non-JSON error bodies are captured.
Client identity uses the socket IP, not forwarded headers. Tailscale hostnames
are refreshed at startup and every five minutes; lookup failures retain the
previous cache and unknown IPs fall back to their IP string.

SQLite uses bundled SQLite and factory-db settings: WAL, one writer and two
readers on dedicated threads. Non-blocking writes enter a bounded 1,024 queue;
overflow drops facts, never stalls forwarding. A writer barrier gives reads
FIFO visibility of accepted writes. STRICT typed columns replace duplicate JSON;
wire timestamps remain `ts` in milliseconds and durations remain nanoseconds.
GPU samples expire after seven days, on startup and each sampling cycle.
Request history has no automatic retention. SIGINT/SIGTERM drains HTTP requests
then waits for queued writes. Forced termination can lose unfinished/queued
records; SQLite errors are logged. Overflow increments separate request/GPU
counters, logs a rate-limited warning, and writes one `drop_episodes` row when
the queue drains. After a failed write, database endpoints report 503 until
storage is repaired and meter restarts. No durability guarantee is made for an
unwritable disk.

Runtime refuses any schema version except 1 and never creates tables. Initialize
an empty DB with `meter migrate --db NEW`. Convert legacy files offline with
`meter migrate --legacy OLD --db NEW`; `--dry-run` validates into a temporary
file and removes it. Legacy input stays read-only; nonempty output paths are
refused. Invalid JSON, unknown fields, overflow, NULL/type violations, timestamp
mismatches and wire differences fail without publishing a new DB. Reports include
counts, ID summaries/sequences, nulls, token sums, timestamp ranges and elapsed ms.

## Internal endpoints

All return JSON. API types live in `shared`; schema is generated by utoipa.

- `GET /meter/health`: checks the SQLite writer/read queue; status plus build identity.
  Adds `dropped_requests`, `dropped_gpu_samples` (since start), and `queue_depth`;
  status remains `ok` after overflow. Durable episodes remain in the DB.
  This is not an Ollama or GPU readiness check.
- `GET /meter/stats?range=24h|7d|30d&model=...`: array of per-model request counts,
  input/output token sums, average prompt/generation tokens per second, and
  nearest-rank p50/p95 total latency. Default range: 24h. Model filter is exact
  (use upstream's returned name, e.g. `factory-assist:latest`). Includes failed
  requests and a null-model group for non-model endpoints. Token sums include
  only reported counts. Rates average each reported tokens/duration pair with
  positive duration; no durations means null rates. Latency uses Ollama's
  `total_duration` where present, otherwise measured request wall time.
- `GET /meter/requests?limit=N`: newest first, default 100, allowed 1–10000.
  `ts` is Unix milliseconds; Ollama durations are nanoseconds; `latency_ms`
  measures request-to-response completion, including stream backpressure.
  `after_id=N` returns ascending ID pages for factory-api sync. Attribution fields
  are optional; converted history has NULL `user_key` and `actor_kind=unattributed`.
- `GET /meter/gpu`: live `nvidia-smi` memory (MiB), utilization (%), temperature
  (°C), power (W), plus the unmodified JSON content of Ollama `/api/ps` in
  `ollama_ps`. **Never derive VRAM from `/api/ps`'s `size`**, which misreports
  gemma4. Missing NVIDIA telemetry or failed `/api/ps` returns 503.
- `GET /meter/gpu/history?range=24h|7d|30d`: oldest first, default 24h.
  Even a 30d query can only return the retained seven days.
- `GET /meter/openapi.json`: OpenAPI 3.1 paths and shared schemas.

Bad query values return 400; unknown `/meter/*` paths return 404; non-GET
internal requests return 405. These are never sent to Ollama.
There is no authentication here. Keep inbound access restricted to `tailscale0`
by the existing host firewall; metering metadata is visible to allowed clients.

## Install (administrator action; meter downtime)

Deployment scripts are artifacts, not executed during development. Run from
the checkout on factory-gpu. Build as `agent`, without sudo:

```sh
cargo build --release --locked -p meter
```

Then install as an administrator:

```sh
sudo bash /home/agent/work/factory/deploy/install-meter.sh /home/agent/work/factory/target/release/meter
```

The installer never runs Cargo. Its required argument is the prebuilt binary;
a missing or non-executable binary fails before any system changes.
Installation requires sudo, Python 3,
SQLite CLI, zstd, installed MET-74 backup scripts, curl, systemd, useradd,
`nvidia-smi`, `tailscale`, and the existing Ollama unit
and drop-in. Rust tooling is needed only for the unprivileged build.

The idempotent installer creates the dedicated `meter` system user and
`/srv/factory/meter`, installs
`/usr/local/bin/meter` atomically and `deploy/meter.service`, and changes only
`OLLAMA_HOST` in `/etc/systemd/system/ollama.service.d/override.conf` to
`127.0.0.1:11435`. Other lines/variables, including model path, flash attention,
and KV cache settings, are preserved. Before editing the drop-in, it copies
the complete file, with permissions, ownership, and timestamps preserved, to
`ollama-drop-in` in the printed snapshot directory.
Each installation creates a snapshot under `/var/backups/meter` with the previous
binary/unit and DB generation. Read-only preflight checks the binary version,
legacy fingerprint/schema version and at least 3× DB disk space. The installer
holds `/var/backups/factory-db/.backup.lock`, stops only meter, takes and verifies
a fresh MET-74 snapshot, and converts as `meter` before swapping files. It retains
`meter.v0.db` with WAL/SHM and installs v1 as 0600 meter:meter. First installs use
the real empty-DB migration; v1 reruns skip conversion. Migration elapsed ms prints.
It reloads systemd and restarts Ollama only when the drop-in changes; otherwise
it prints `Ollama unchanged, not restarted`. It starts meter and verifies `/api/version` and
`/meter/health` on :11434. Startup checks poll silently for up to 45 seconds,
then perform one visible curl with an explicit error on failure.
After startup it also requires these checks to pass:

- `sudo -u meter nvidia-smi -L`, showing the GPU as the real service user.
- `sudo -u meter tailscale status --json`, showing its first byte (`{`). The
  script captures the complete output before slicing, avoiding a false
  SIGPIPE failure under `pipefail` when Tailscale output is large.
- A `/meter/gpu` curl prints the complete response and rejects an empty GPU
  list or missing/null memory used/total, utilization, temperature, or power.
  This exercises telemetry through the actual running systemd service.

**Service-user verification result: not run yet.** Development had no sudo or
permission to install/restart services. Earlier live checks used the agent's
test process, not the `meter` user. The :11500 test proxy is now stopped.
The installer prints `Service-user NVIDIA/Tailscale and live GPU checks passed`
only after all three checks succeed; any failure exits nonzero with an error.

Scripts stop on failure; they do not silently apply
automatic rollback. Inspect errors and run rollback if needed.

The unit wants/starts after Ollama, restarts always, and has a read-only system
with write access only to `/srv/factory/meter`. GPU device access remains
available. It does not change the firewall, Tailscale, models, or GPU settings.
Runtime telemetry failures are logged rather than blocking proxy traffic;
installation treats failed telemetry verification as an error.

## Rollback

For the v1 migration, use the exact snapshot path printed by the installer:

```sh
sudo bash /home/agent/work/factory/deploy/rollback-meter-v1.sh /var/backups/meter/<printed-snapshot-directory>
```

This stops meter, moves v1 and WAL/SHM to a timestamped recovery directory,
restores v0 and the previous binary/unit, and verifies health. It never touches
Ollama. **Rows written after migration remain in recovery and are not restored.**
Keep legacy `*.v0.db` until the next migration is verified and MET-74 holds
seven daily snapshots of the new schema; cleanup is explicit, never automatic.

The older proxy-removal rollback is separate and does restart Ollama:

```sh
./deploy/rollback-meter.sh
```

Stops/disables meter, restores only `OLLAMA_HOST=0.0.0.0:11434`, restarts Ollama,
and verifies `/api/version`. Retains the meter binary, unit, user, and database.
Other Ollama settings are preserved. No model files are touched.
Older installs kept drop-in copies at
`/etc/systemd/system/ollama.service.d/override.conf.bak.<timestamp>`; v1 keeps
them in its printed snapshot directory. Proxy-removal rollback does not
automatically restore a snapshot: a repeated install's
snapshot may already contain `127.0.0.1:11435`. Inspect the appropriate backup
before using it for full-file recovery; normal rollback restores only the host.

## Development checks

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace
bash -n deploy/install-meter.sh deploy/rollback-meter.sh deploy/rollback-meter-v1.sh
python3 -B deploy/test_set_ollama_host.py
```

Tests include fragmented usage JSON, NDJSON and SSE, missing OpenAI usage,
upstream errors, exact body/status/header forwarding, internal routing, GPU
retention, and a slow NDJSON server proving incremental arrival with timing
assertions and a persisted request row.

For the offline migration differential, build the legacy meter and current-main
factory-api from separate archived trees/target directories. Set `LEGACY_METER`,
`MAIN_API`, and `LEGACY_DB` to their absolute paths, then run from this checkout:

```sh
mkdir -p .sandbox
env -i PATH=/usr/bin:/bin HOME="$PWD/.sandbox" bwrap \
  --unshare-net --unshare-pid --unshare-uts --hostname sandbox --die-with-parent \
  --ro-bind / / --bind "$PWD/.sandbox" "$PWD/.sandbox" \
  --proc /proc --dev /dev --tmpfs /run --tmpfs /tmp \
  --setenv PATH "$PWD/scripts/sandbox-shims:/usr/bin:/bin" \
  python3 "$PWD/meter/tests/differential.py" "$LEGACY_METER" \
  "$PWD/target/release/meter" "$MAIN_API" "$PWD/target/release/fake-ollama" \
  "$LEGACY_DB" "$PWD/.sandbox/differential"
```

The output compares both fully synced caches as JSON values without tolerances
or field exclusions. It also reports every raw-to-legacy-cache difference and
isolates changes between the legacy wire and API cache. Existing legacy float
normalization is not a v1 regression. The work directory must not exist; remove
private copies/logs after inspection, and never commit reports containing real
metadata. Processes shut down in the private namespace even when a check fails.

## Future

- factory-api consuming the shared contract and pricing library.
- Request retention after verified rollups; factory-api/factory-status surfacing
  meter overflow counters and durable drop episodes.
- Kiosk/UI and access controls if the trusted-tailnet boundary changes.

## factory-api: aggregation API v1

`factory-api` is now implemented. It runs on factory-console, consumes the
deployed meter on `http://factory-gpu:11434`, and leaves meter and Ollama unchanged.
The additive serde/utoipa contract is in `shared::factory_api`; OpenAPI is at
`GET /openapi.json`. The trusted tailnet and existing host firewall are the
security boundary. There is no application authentication: never expose this
listener to an untrusted network. Pricing confirmation is an operator-only
POST, not a kiosk action.

Build and run without installing anything:

```sh
cargo build --release --locked -p factory-api
db_dir=$(mktemp -d)
target/release/factory-api --listen 0.0.0.0:18080 \
  --meter-url http://factory-gpu:11434 \
  --db-path "$db_dir/requests.db" --pricing-db-path "$db_dir/pricing.db"
```

Defaults and environment equivalents (CLI flags take precedence):

- `--listen` / `FACTORY_API_LISTEN`: `0.0.0.0:8080`.
- `--meter-url` / `FACTORY_API_METER_URL`: `http://factory-gpu:11434`.
- `--db-path` / `FACTORY_API_DB_PATH`: `/var/lib/factory-api/requests.db`.
- `--pricing-db-path` / `FACTORY_API_PRICING_DB_PATH`: `/var/lib/factory-api/pricing.db`.
- `--openrouter-feed-url` / `FACTORY_API_OPENROUTER_FEED_URL`:
  `https://openrouter.ai/api/v1/models`.
- `--litellm-feed-url` / `FACTORY_API_LITELLM_FEED_URL`:
  `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`.
- `--disable-pricing-collector` / `FACTORY_API_DISABLE_PRICING_COLLECTOR=1`:
  default off. Skips startup/daily pricing refresh only; manual refresh,
  confirmation and snapshot reads still work. Environment value `0` keeps it enabled.
- `--services-config` / `FACTORY_API_SERVICES_CONFIG`: optional TOML file;
  defaults are embedded from `factory-api/config/services.toml`.
- `--static-dir` / `FACTORY_API_STATIC_DIR`: `/var/lib/factory-api/kiosk`;
  runtime kiosk files, not embedded in the binary.
- `RUST_LOG`: defaults to `factory_api=info`.

Feed overrides must be absolute HTTP(S) URLs. HTTPS is required except for
loopback hosts (`127.0.0.0/8`, `::1`, `localhost`); invalid values fail startup.
Effective URLs are logged once without query strings, fragments or credentials.
Disabling the collector does not bypass the clock-synchronization write guard.

Database parent directories must exist. Request and pricing paths must differ.
SQLite uses bundled SQLite, WAL and five-second busy timeouts. Database work and
the synchronous pricing crate run through `spawn_blocking`. Meter sync and fleet
checks start immediately and repeat every 30 seconds. Live GPU SSE samples repeat
every 15 seconds. Pricing refresh runs at startup and daily; it never confirms.
Collectors retry on the next interval without blocking health or SSE.

Endpoints:

- `GET /v1/health`: status, build identity, process uptime in milliseconds.
- `GET /v1/fleet`: configured Tailscale nodes and HTTP/TCP/local systemd checks.
  HTTP requires 2xx; redirects fail. Checks time out after five seconds.
  `systemd` targets are allowed only on factory-console. Missing discovery data
  gives offline nodes and null metadata; failed service checks retain details.
  The embedded self-check follows `--listen`'s port, including the :18080 check.
- `GET /v1/llm/usage?range=24h|7d|30d`: totals, reference-family spend avoided,
  per-model tokens/rates/nearest-rank latency percentiles, load time and warnings.
  Default range is 24h. All meter rows count, including non-model requests;
  missing models remain null. Missing token counts do not invent tokens.
- `GET /v1/gpu?range=1h|24h|7d`: live physical GPU 0, loaded model names and
  history. Default range is 1h, filtered from meter's 24h history. NVIDIA data
  supplies memory; Ollama model sizes never do. Failed upstream calls return
  null current/empty lists with HTTP 200, log diagnostics, and surface warnings
  in usage (the GPU contract has no warnings field).
- `GET /v1/pricing` and `POST /v1/pricing/refresh`: selected/pending families,
  confirmed-model rates and warnings. A source outage preserves the last snapshot
  with HTTP 200 and warnings. Rates remain null until a selection is confirmed.
- `POST /v1/pricing/confirm/{family}`: explicitly confirms the current pending
  selection. Percent-encode spaces. Unknown families return 404; no pending
  selection returns 409. Never called automatically.
- `GET /v1/agents`: amp, cursor, claude-code, codex and kimi are `not_tracked`.
- `GET /v1/stream`: SSE events named `gpu.sample`, `llm.request`, `fleet.change`,
  and `pricing.changed`, with JSON `{type, ts_ms, data}`. Independent
  `: keepalive` comments run every 15 seconds, even during event traffic.
  Events are live notifications, not replayable history; reconnecting clients
  should fetch snapshots. Lagged subscribers skip missed events with a log warning.

Errors use `{error:{code,message}}`; malformed ranges return 400, unknown paths
under `/v1/` return 404, wrong API methods return 405. Local storage failures
return 500, unlike upstream outages.
Timestamps are Unix milliseconds (`*_ms`); pricing seconds are converted at the
boundary. Ollama nanoseconds become milliseconds for latency/load and seconds
for tokens per second. Prompt/generation rates average valid per-request ratios,
exclude load time and remain null when no positive duration exists.

Spend avoided is calculated independently for each reference family, not added
across families. Dated requests use `pricing::Store::cost`. Pre-history requests
use the earliest confirmed selection's earliest observed rate and accumulate
only in `estimated_usd`. Factory-api reads that append-only history without
modifying pricing's tables. Without any confirmed selection, or when either
token count is null, a request increments `unpriced_requests`.

The request cache upserts meter IDs and persists its max-ID watermark across
restarts. Only the newest 500 rows are available per sync. If the oldest fetched
ID exceeds watermark + 1, a persistent `gap` warning identifies lost IDs.
There is no automatic request retention or gap backfill. Upstream failures retain
cached usage with warnings. A fresh cache cannot reconstruct older meter history.

Deployment artifacts are **not executed during development**:

```sh
# Administrator action only, after the unprivileged build:
sudo bash deploy/install-factory-api.sh /path/to/prebuilt/factory-api
# Use the exact timestamped snapshot printed by installation:
sudo bash deploy/rollback-factory-api.sh /var/backups/factory-api/<snapshot>
```

The dedicated `factory-api` user gets `/var/lib/factory-api` through systemd
`StateDirectory`. The unit uses `ProtectSystem=strict` and `NoNewPrivileges`.
The installer never runs Cargo, performs preflight checks, snapshots existing
binary/unit files and prior service state, starts port 8080, curls health/fleet,
and verifies Tailscale and amp-runner as the service user. The health startup
check polls silently for up to 45 seconds, followed by one visible curl with an
explicit error on failure. Rollback restores those
files and service state; databases and user remain. Neither script changes meter,
Ollama, firewall rules, or Tailscale configuration.

### Runtime kiosk and installation

`GET /` serves `index.html` from the static directory. Existing files use their
content types; unknown non-API GET paths accepting `text/html` use the same
index for SPA routes. HEAD is also supported. `/v1`, `/v1/*` (including SSE),
and `/openapi.json` always remain API paths, even if matching files exist.
There are no directory listings. Decoded traversal, absolute paths and
backslashes are rejected; symlinks cannot escape the static directory.
Responses include `X-Content-Type-Options: nosniff`. Index and SPA responses
use `Cache-Control: no-cache`; `assets/*` uses
`public, max-age=31536000, immutable`, so builds must use hashed asset filenames.
Other files use `no-cache`.

A missing or empty static directory serves a built-in HTTP 200 placeholder at
`/`: system-matched Light/Dark background from the first paint, centered
“factory · kiosk not deployed yet”, system font, and a 30-second auto-reload.
API endpoints work independently of kiosk files.

After deploying the static-capable API binary, install an already-built kiosk
dist as an administrator. These scripts are artifacts, not run in development:

```sh
sudo bash deploy/install-kiosk.sh /path/to/kiosk/dist
# Default dist: /home/agent/work/factory/kiosk/dist
sudo bash deploy/install-kiosk.sh
# Restore latest complete pre-install snapshot, or specify one:
sudo bash deploy/rollback-kiosk.sh
sudo bash deploy/rollback-kiosk.sh /var/backups/factory-kiosk/<snapshot>
```

Both scripts require root, the existing factory-api account/group and state
directory, curl, GNU coreutils with `mv --exchange --no-copy`, and `flock`.
The filesystem must support atomic directory exchange. Preflight rejects unsafe
paths and non-regular entries (including symlinks). Install requires `index.html`,
snapshots the current tree or its absence under `/var/backups/factory-kiosk`,
copies the dist to a sibling temporary directory, sets `root:factory-api`
ownership and read-only modes (0550 directories, 0440 files), then atomically
exchanges directories (or renames on first installation). Install and rollback
share a lock. Snapshots remain available after failures; neither script silently
rolls back. Rollback restores the selected snapshot, including a missing/empty
tree. Both verify `GET /` against the installed/restored index or placeholder.
Neither script builds anything, restarts services, or changes meter/Ollama.

Validation: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
`cargo test --workspace`, and `bash -n` for the API and kiosk deployment scripts. Factory-api
tests cover every unit conversion, dated/estimated/unpriced spend, null tokens,
TPS math, mock-meter endpoint JSON, upserts/gaps/outages, fleet check kinds,
OpenAPI references, explicit confirmation, a real HTTP SSE event, runtime static
updates, SPA fallback, API precedence, cache/content headers, traversal rejection,
symlink escapes, and missing/empty-directory placeholders.
See [the live check](factory-api/LIVE_CHECK.md) for observed outputs and limits.

## Cross-host SQLite backups (MET-74)

`deploy/backup/` backs up running services without copying live SQLite files.
Root uses SQLite's `.backup` API (including committed WAL data), requires exactly
`ok` from `PRAGMA integrity_check`, compresses with zstd, and publishes a SHA-256
sidecar. Failed snapshots never become successful status entries. The databases are:

- factory-gpu: `meter`, `/srv/factory/meter/meter.db`.
- factory-console: `requests`, `/var/lib/factory-api/requests.db`, and `pricing`,
  `/var/lib/factory-api/pricing.db` (factory-api's systemd `StateDirectory`).

Snapshots are `/var/backups/factory-db/<host>/<db>/<UTC-timestamp>.db.zst` with
adjacent `.sha256` files. Local snapshots are root-owned and read-only to the
`factory-backup` group. Only the dedicated, password-locked system user
`factory-backup` runs network operations: `rsync -a --partial -e ssh` over
Tailscale SSH, **never
`--delete`**. Incoming replicas live at `/srv/factory/backups/replica` on
factory-gpu and `/var/backups/factory-replica` on factory-console, under
`<source-host>/<db>/`. Each replica root has mode 0700 and is owned by
`factory-backup`. Its home is `/var/lib/factory-backup`, also owned by it with
mode 0700. The immediate replica parents (`/srv/factory/backups` on factory-gpu,
`/var/backups` on factory-console) are root-owned 0711: traversal without directory
listing. Higher shared ancestors are not changed and must permit traversal.
No sudo permissions or SSH keys are granted; `/bin/sh` supports rsync remote
commands, unlike a `nologin` shell. Ubuntu's built-in `backup` account is never
used for these backups.

Every SSH operation explicitly sets
`-o UserKnownHostsFile=/var/lib/factory-backup/known_hosts`
and `-o StrictHostKeyChecking=accept-new`. No operation depends on `~/.ssh`.
First-use keys are recorded over the trusted tailnet; changed keys still fail.

The oneshot service runs as root at 03:15 on factory-gpu and 03:45 on
factory-console, in each host's local timezone, with `RandomizedDelaySec=10m`
and `Persistent=true`. Filenames and retention dates use UTC. Each DB retains
the newest copy on each of the seven newest available daily dates, plus the
four newest available Sunday copies. Overlap counts once; reruns do not consume
daily slots. The newest copy is never pruned. Any snapshot or push failure
skips all pruning for that run. After a successful push, the receiving host
prunes its own replica as `factory-backup`, then the sender prunes its local tree.
Receiver pruning requires today's complete, checksummed copies for every DB
from that source, so missing/failed days do not trigger deletion. This avoids
depending on whether the peer's staggered timer has already run.

`/var/lib/factory-backup/status.json` is atomically replaced, with a top-level
entry for each local DB: `last_success_ms`, `last_attempt_ms`, `size_bytes`
(compressed), `integrity` (`ok`, `failed`, or null before checking),
`pushed_to_peer` (boolean), and `error` (string or null). A successful run means
snapshot, push and retention finished; failures preserve `last_success_ms`.
Every failure exits nonzero for systemd/journald. The root lock is
`/var/backups/factory-db/.backup.lock`, outside the SSH user's writable home.
Inspect with:

```sh
sudo cat /var/lib/factory-backup/status.json
systemctl list-timers factory-backup.timer
journalctl -u factory-backup.service
```

### Install on both nodes (Devon; requires MET-73)

Do not run the installer during development. No application service is stopped
or restarted by installation or backups. Both nodes need existing databases,
systemd, active tailscaled with Tailscale SSH enabled, SQLite CLI, zstd, rsync,
OpenSSH client, Python 3.11+, and standard Ubuntu coreutils/util-linux/account
tools. Install missing packages as administrator:

```sh
sudo apt-get install sqlite3 zstd rsync openssh-client python3
```

To avoid changing another agent's checkout/branch, fetch and create an isolated
MET-74 checkout on **each node**, as the checkout owner (not root):

```sh
export GH_TOKEN="$AGENT_GH_TOKEN"
gh auth setup-git
git fetch origin
git worktree add --detach /home/agent/work/factory-backup-fix \
  origin/devon/met-74-dedicated-backup-account
cd /home/agent/work/factory-backup-fix
```

After the fix PR is merged, use `origin/main` instead of the feature branch.
Do not run the stale original installer from an older worktree.

**Require the MET-73 Tailscale SSH rule before completing installation.** Devon
must tag both nodes `tag:factory`, enable Tailscale SSH on both, permit TCP 22
between them in the network policy, and add this SSH rule to the existing policy
(do not replace unrelated rules). Use `accept`, not interactive `check`, for
unattended backups:

```json
{
  "action": "accept",
  "src": ["tag:factory"],
  "dst": ["tag:factory"],
  "users": ["factory-backup"]
}
```

First, on **factory-gpu**, from the MET-74 checkout:

```sh
sudo bash deploy/backup/install-backup.sh --prepare-only
```

Then, on **factory-console**, from the same checkout:

```sh
sudo bash deploy/backup/install-backup.sh --prepare-only
```

Preparation migrates the accounts/directories, installs config/units, and checks
real filesystem access as `factory-backup`. It stops the backup service and
disables/stops its timer, including an existing timer, until full installation
passes. No application service is stopped. Once both nodes are prepared
and MET-73 is active, run on **factory-gpu**, then **factory-console**:

```sh
sudo bash deploy/backup/install-backup.sh
```

Each completion run checks peer access using the explicit known_hosts path,
runs an immediate backup through systemd, verifies local restores, then enables
the timer. After both
completion runs, verify local and received copies on **each node**:

```sh
sudo /usr/local/lib/factory-backup/restore-check.sh all
```

The installer is idempotent, preflights dependencies/databases/accounts/paths
and unit overrides, and stops on errors with no automatic rollback. Before any
peer connection or timer enable, it runs `factory-backup.sh --check-access` as
`factory-backup`: actual ancestor traversal, replica read/write access (including
a temporary file), home traversal/write access, and known_hosts read/write.
Normal backups run the same probe before snapshotting to catch permission drift.
Fix the reported failure and rerun. It installs scripts in `/usr/local/lib/factory-backup`
and a single root-owned config at `/etc/factory-backup/nodes.conf`; reinstalling
replaces that config from the checkout. No firewall, Tailscale policy or live DB
is changed. A failed completion leaves the timer disabled; rerun to finish.

### Migration from the original MET-74 installer

Run the two preparation steps above even if the old `backup` account has already
been restored. Both legacy and partially repaired states are supported:

- If Ubuntu's `backup` uid/gid 34 still has this node's replica root as its home
  and `/bin/sh` as its shell, restore `/var/backups`, `/usr/sbin/nologin`, and its
  disabled password (`*`). If its home is already `/var/backups`, leave the entire
  account unchanged. No distro account is repurposed for future backups.
- Create/configure only the dedicated system account `factory-backup`, with a
  locked password, its own group only, no sudo grants, and home 0700.
- Transfer the entire replica tree to `factory-backup:factory-backup`, without
  following symlinks or deleting snapshots. Change the local archive group to
  `factory-backup` while retaining root ownership and existing snapshot modes.
- Merge legacy `<replica-root>/.ssh/known_hosts` with the new explicit known_hosts
  file, preserving trusted keys. Remove that legacy file, `known_hosts.old`, and
  the empty `.ssh` directory. Unexpected administrator-added files (such as
  `authorized_keys`) fail preflight for review; they are not silently deleted.
- Preserve `status.json`. Remove the obsolete home `backup.lock`; new root locks
  are outside the account-owned home, preventing symlink-based file truncation.

If an administrator has already restored `backup`, preparation still migrates
replica ownership and legacy SSH artifacts without changing that account.
Prepare factory-gpu, prepare factory-console, then complete factory-gpu and
factory-console in that order, with `users: ["factory-backup"]` in the SSH policy.

### Read-only restore checks and manual recovery

`restore-check.sh [local|replica|all]` (default `all`) verifies the checksum of
the newest copy of every selected DB, decompresses only into a temporary
directory, checks integrity, and prints row counts for every table (including
quoted table names). Missing/corrupt copies fail; it **never replaces live DBs**.
Use `local` during first-node bootstrap before incoming replicas exist.

Manual restoration is an explicit administrator action. Choose a verified copy
from either local snapshots or received replicas and retain its sidecar. For
meter use service/user `meter` and `/srv/factory/meter/meter.db`; for either
console DB use service/user `factory-api` and its corresponding path above.
Restore requests and pricing together when recovering the whole console.
Run the following in a root Bash shell, setting the three paths/names first.
`set -e` ensures a bad checksum or integrity result stops before replacement:

```sh
set -euo pipefail
service=meter
database=/srv/factory/meter/meter.db
archive='/var/backups/factory-db/factory-gpu/meter/<UTC-timestamp>.db.zst'
systemctl stop factory-backup.timer factory-backup.service
systemctl stop "$service.service"  # meter only; does not stop Ollama
(cd "$(dirname "$archive")" && sha256sum --strict -c "$(basename "$archive").sha256")
temporary=$(mktemp -d "$(dirname "$database")/.restore.XXXXXX")
zstd -d "$archive" -o "$temporary/verified.db"
test "$(sqlite3 -readonly "$temporary/verified.db" 'PRAGMA integrity_check;')" = ok
chown "$service:$service" "$temporary/verified.db"
chmod 0600 "$temporary/verified.db"
# Keep the old DB and any WAL/SHM together; never replay stale WAL onto a restore.
recovery=/var/backups/factory-db/pre-restore-$(date -u +%Y%m%dT%H%M%S.%NZ)
mkdir -m 0700 "$recovery"
printf 'Pre-restore originals: %s\n' "$recovery"
for file in "$database" "$database-wal" "$database-shm"; do
  if test -e "$file"; then mv -- "$file" "$recovery/"; fi
done
mv -- "$temporary/verified.db" "$database"
rmdir "$temporary"
systemctl start "$service.service"
systemctl start factory-backup.timer
```

Do not restart the application between replacing requests and pricing when
restoring both. Check its health endpoint before declaring recovery complete.
If any step fails, keep services stopped until the paths/error are reviewed;
the originals remain at the printed/selected recovery location.

### Backup development checks (no root)

```sh
python3 -B deploy/backup/test-backup.py
for script in deploy/backup/*.sh deploy/backup/nodes.conf; do bash -n "$script"; done
shellcheck -x deploy/backup/*.sh deploy/backup/nodes.conf
```

The contract check runs the real scripts with local rsync, three sample WAL
databases and active writers. It verifies transaction consistency, integrity,
compression, checksums, exact survivors of 40 dated copies on both trees,
same-day reruns, Sunday retention, status, read-only restore output, and no
deletion on missing/corrupt DBs, failed pushes, or incomplete incoming copies.
It also exercises kernel-enforced traversal/write failures, rejects unsafe
known_hosts links, and checks repeatable migration on both node configurations
with both legacy and already-restored Ubuntu accounts. Account administration
and uid/gid changes are modelled without root; directory modes, key migration,
access probes and data preservation are checked against the real filesystem.
Development overrides are `BACKUP_HOST`, `BACKUP_HOME`, `METER_DB`, `REQUESTS_DB`,
`PRICING_DB`, `LOCAL_ROOT`, `REPLICA_ROOT`, `PEER_REPLICA_ROOT`, `STATUS_FILE`, and
`BACKUP_TRANSPORT=local`. `BACKUP_CONFIG` selects a trusted alternative config.
The installer clears development overrides and always uses real node defaults.
These unprivileged checks do not prove production Tailscale SSH/root permissions;
the administrator's immediate systemd backup and restore checks do that.
