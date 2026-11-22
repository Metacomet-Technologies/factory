# factory-api: aggregation API v1

`factory-api` targets factory-gpu, consumes meter on `http://127.0.0.1:11434`,
and leaves meter and Ollama unchanged.
The additive serde/utoipa contract is in `shared::factory_api`; OpenAPI is at
`GET /openapi.json`. The trusted tailnet and existing host firewall are the
security boundary. There is no application authentication: never expose this
listener to an untrusted network. Pricing confirmation is an operator-only
POST, not a kiosk action.

Build and run without installing anything:

```sh
cargo build --release --locked -p factory-api
db_dir=$(mktemp -d)
target/release/factory-api --listen 127.0.0.1:18080 \
  --meter-url http://127.0.0.1:11434 \
  --db-path "$db_dir/requests.db" --pricing-db-path "$db_dir/pricing.db"
```

Defaults and environment equivalents (CLI flags take precedence):

- `--listen` / `FACTORY_API_LISTEN`: `127.0.0.1:8080` (MET-84; Serve is the tailnet entry point).
- `--meter-url` / `FACTORY_API_METER_URL`: `http://127.0.0.1:11434`.
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
  defaults are embedded from `factory-api/config/services.toml`. A node with
  `satellite = true` (factory-console) is optional: while it is offline the
  kiosk verdict stays green, its tile reads "Off · satellite", and the offline
  alert is a one-time Info post instead of Critical.
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
  `systemd` targets are allowed only on factory-gpu. Missing discovery data
  gives offline nodes and null metadata; failed service checks retain details.
  The embedded self-check follows `--listen`'s port, including the :18080 check.
  GPU hosts API/static/meter/Ollama and the backup timer. Console's
  `backup-replica-ssh` checks transport reachability only, not replica freshness,
  Chrome, or its Amp runner; no remote systemd execution or watchdog is added.
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
- `GET /v1/agents`: Amp, Claude Code and Codex usage from `--usage-snapshot` /
  `FACTORY_API_USAGE_SNAPSHOT` (default `/var/lib/factory-usage/usage.json`).
  Missing/invalid snapshots return 200 with unknown tracked tools and a reason.
  Tracked tools are Amp, Cursor, Claude Code, Codex, Kimi and OpenCode.
  Cursor reports plan only. OpenCode reports local session cost, not remaining
  quota. Kimi reports local quota windows and a USD wallet when present.
- `GET /v1/stream`: SSE events named `gpu.sample`, `llm.request`, `fleet.change`,
  `pricing.changed`, and `agents.usage`, with JSON `{type, ts_ms, data}`. Independent
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

The request cache inserts immutable meter facts and persists a separate
`sync_state` cursor. Sync uses ascending `after_id` pages of up to 500 rows,
bounded to 20 pages per poll, and resumes committed progress after interruption.
The offline requests.db v4 migration rebuilds the replica from `after_id=0`
while preserving UPS/device/network history and archived legacy cache tables.
Historical replay does not emit live request events. Gap warnings clear only
when every missing ID is recovered; unavailable source IDs remain warnings.
There is no automatic request retention. See [cache recovery](../docs/data-model.md#cache-recovery-implementation-met-203).

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
explicit error on failure. Before requests migration, the installer stops the
service and verifies a fresh SQLite backup and telemetry row counts. Rollback
restores that database snapshot and the compatible binary, reverting telemetry
to snapshot time while retaining displaced files for recovery. The service user
remains. Neither script changes meter,
Ollama, firewall rules, or Tailscale configuration.

## Runtime kiosk and installation

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
See [the live check](LIVE_CHECK.md) for observed outputs and limits.
