# Meter

Meter transparently proxies Ollama and records request metadata in SQLite.
Deploys go through `deploy/autodeploy.sh` like every component; the install and
rollback details below are what `factory-deploy` runs.

## Client identity

Client identity comes from the socket IP, never forwarded headers. IPv4 and
IPv6 loopback clients retain their IP in `client_ip`, but `client_hostname`
is the local machine's hostname, read through `gethostname` and cached at
startup. Other clients use the refreshed Tailscale hostname cache, falling
back to their IP string when unknown. Existing database rows are not rewritten.

## Incremental request sync

`GET /meter/requests` always returns a JSON array of request records.

- Without `after_id`, behavior is unchanged: newest ID first, default limit
  100, allowed limits 1–10000. There is no cursor header.
- With a nonnegative `after_id`, return records with `id > after_id`, ordered
  by ascending ID. The default limit is 500; allowed limits are 1–5000.
  Invalid cursors or limits return HTTP 400.
- Cursor responses include the `next_after_id` header. It contains the last
  returned ID, or the supplied cursor if the page is empty.
- Nonempty cursor responses also include `oldest_retained_id`, the lowest
  stored ID from the same read. Lower IDs were removed by 365-day retention,
  not lost; retention deletes only from the lowest ID upward (see
  `docs/data-model.md`, MET-206).

Start with `after_id=0`, persist the response's cursor only after storing every
record in that page, and repeat until the response array is empty. Resume from
the saved cursor on the next sync. IDs, not timestamps or row counts, define
the cursor. A replaced database requires resetting the client's cursor.

```sh
curl -i 'http://127.0.0.1:11500/meter/requests?after_id=0&limit=500'
# Use the response's next_after_id for the next page:
curl -i 'http://127.0.0.1:11500/meter/requests?after_id=500&limit=500'
```

`GET /meter/openapi.json` documents both modes and the response header.
Factory-api continues to use the legacy mode until its separate migration.

## Isolated live check

Build as `agent`. Do not restart the deployed meter or Ollama for validation.
Use an unused port and a temporary database:

```sh
cargo build --release --locked -p meter
db_dir=$(mktemp -d)
target/release/meter --listen 127.0.0.1:11500 \
  --upstream http://127.0.0.1:11434 --db-path "$db_dir/meter.db"
```

In another shell, send requests to `/api/version`, inspect `/meter/requests`,
then page using `after_id`. Stop only the test process afterward and remove
its temporary database. Forwarded live checks also create rows in the deployed
upstream meter, but do not alter its configuration or existing records.

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
file and removes it. Real conversion requires a stopped, checkpointed legacy DB:
it refuses a nonempty WAL and opens the source immutable, creating no sidecars.
`--dry-run` and `--check-only` use WAL-aware read-only connections and may create
WAL/SHM files; run them as the DB owner (`meter` on production), never root.
Nonempty output paths are refused. Invalid JSON, unknown fields, overflow, NULL/type violations, timestamp
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
holds `/var/backups/factory-db/.backup.lock`, stops only meter, verifies its PID
is gone and checks DB/sidecar holders with `fuser` when available. For both legacy
and v1 databases, it runs `PRAGMA wal_checkpoint(TRUNCATE)` read-write as `meter`,
prints busy/log/checkpointed counts, and requires busy=0, equal frame counts and
an absent or empty WAL. This moves committed frames into the main file without
changing logical contents. An incomplete checkpoint fails with the rollback hint
and leaves meter stopped for administrator recovery. Then it rechecks the schema
version, takes and verifies a fresh MET-74 snapshot, captures the stopped generation,
and converts as `meter` before swapping files. It retains
`meter.v0.db` with WAL/SHM and installs v1 as 0600 meter:meter. First installs use
the real empty-DB migration; v1 reruns skip conversion. Migration elapsed ms prints.
V1 SIGTERM drains writes, closes every pool connection, and finishes with a
writable truncate checkpoint; the installer still checkpoints independently.
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
sudo bash /home/agent/work/factory/deploy/rollback-meter.sh
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

`scripts/check` (see `AGENTS.md`).

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
