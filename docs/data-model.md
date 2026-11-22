# Factory data model

How meter, factory-api and pricing store data in SQLite: the implemented
MET-92 stages, the legacy version-zero schemas the migrations start from, and
the target schema contract. The rules for new DB work are in
[docs/agents/db.md](agents/db.md).

## Cache recovery implementation (MET-203)

Migration numbers in the target schema contract below are design-era names,
not the current database versions. On 2026-10-17, main has API
`requests.db` v3 (v1 UPS, v2 devices, v3 network), meter v1, and pricing v1.
MET-203 adds **API v4**; it changes neither meter nor pricing. Allocate subsequent
schema versions from the then-current manifests, never from the original table.

After stopping factory-api and taking a fresh verified backup, run
`factory-api migrate --requests-db <path>`. The shared migration runner upgrades
versions 0–3 transactionally, preserving all UPS/device/network tables. It renames
the legacy cache and warnings to `requests_before_v4` and `warnings_before_v4`,
creates the typed STRICT request replica and timestamped warnings, and initializes
`sync_state.last_after_id` to zero. It does not convert legacy request JSON or
replace the database file. Archived legacy tables keep their original schema and
are not read as live facts. They remain until explicitly approved cleanup.
Runtime refuses an existing pre-v4 or future-version file; only a new empty
database may be initialized without the offline command.

The installer holds the MET-74 backup lock, stops the service, makes and verifies
a SQLite backup including committed WAL frames, records the old schema version,
and compares telemetry row counts before/after migration. Database opens in the
new request-backup path run as the service user to avoid root-owned WAL sidecars.
The installer never starts the new binary against an old request schema.

Replay uses ascending pages of at most 500 rows, at most 20 pages per poll.
Each transaction inserts immutable typed facts and advances the singleton cursor;
interruptions resume from that cursor, not `MAX(id)`. Invalid IDs, ordering,
signed-integer overflow, nonfinite latency and schema constraints fail the page
without advancing progress. Historical replay does not emit live `llm.request`
events. Usage carries a rebuilding warning until an empty cursor page confirms
catch-up; reaching the work bound leaves a transient catch-up warning.

Legacy warning strings retain their exact message and get migration-time
first/last observation times. Recognized ID ranges, including 340–421, resolve
only after every ID is present in the new cache. A successful poll is not enough.
Unavailable source IDs remain warnings. Missing previously cached rows also
produce a coverage warning. `sync_state.replay_through_id` records the legacy
maximum for replay/event suppression; `rebuilding` persists across restarts.

Normal sync budgets are one initial cursor read, then
`2 + ceil(rows/100) + ceil(gaps/100)` data statements per nonempty page and three
on the final empty page. Migration replay additionally compares retained legacy
IDs once at catch-up. The current usage/pricing read budgets remain 16/9.

Rollback uses the installer's verified pre-migration `requests.db` snapshot and
compatible binary. **This restores all telemetry to the backup time**, not just
request history. The rollback script preserves displaced database/WAL/SHM files
for recovery; it does not merge later telemetry automatically. Pricing is
preserved unless its own migration is being rolled back. No production migration
or recovery has been verified by the synthetic tests.

Remaining approved MET-92 stages are tracked separately: frozen costs
[MET-204](https://linear.app/metacomet/issue/MET-204), rollups
[MET-205](https://linear.app/metacomet/issue/MET-205), then gated retention,
snapshots and runtime query-counter alerts
[MET-206](https://linear.app/metacomet/issue/MET-206). MET-203 adds no pruning.

## Frozen request costs implementation (MET-204)

On 2026-10-17, main has API `requests.db` v4 (MET-203), meter v1 and pricing v1.
MET-204 adds **API v5**; meter and pricing code and schemas are unchanged.

After stopping factory-api and taking a fresh verified backup, run
`factory-api migrate --requests-db <path>`. The shared runner adds STRICT
`request_costs` with exactly the contract columns, primary key
`(request_id,family)` (WITHOUT ROWID, so key reads touch one B-tree), FK cascade to `requests`, and a table CHECK that
priced/estimated rows have cost, provenance and rates while unpriced rows have
none. It adds index `(family,request_id)` and a `BEFORE UPDATE` trigger that
rejects every update except unpriced → estimated. STRICT `cost_backfill` holds one
row per configured family: `after_id`, `target_id`, `unpriced_from_id` and
`completed_at_ms`. Migration seeds `target_id=MAX(requests.id)`; an empty cache is
seeded complete because later rows are frozen at ingestion. No existing table or
row changes, no data is copied, and the file is never replaced. Runtime refuses
v4 and newer versions; only a new empty file is initialized without the command.

Classification is per inference request and configured family at `ts_ms`, never
at `priced_at_ms`. The selection is the latest confirmed one effective at or before
the request (equal times: higher ID). The rate is that model's latest snapshot
fetched at or before it (equal times: later refresh, then OpenRouter, then higher
ID). Otherwise the row is estimated from the earliest confirmed selection's
earliest snapshot, matching pre-MET-204 usage. With no such price it is unpriced.
Missing token counts are unpriced; zero tokens are priced zero. Cost is checked
i128 `(p*in + o*out + 500)/1000`, once per request, checked into i64; overflow
is refused. Rows store selection/snapshot IDs, model and rates, plus freeze time.
Pricing's public `History` omits row IDs, so the API runs three equivalent
queries per family through `Store::connection()`. Tests compare them with
`History::rates_at` and `Store::cost`.

Each meter page reads pricing history in one pool read snapshot (3F statements),
then writes requests, costs and cursor in one cache transaction. A pricing storage
or lookup failure, or cost overflow, at request X commits only earlier records,
leaves the cursor before X and surfaces a `meter:` warning. Retries do not skip X.

Backfill runs on every 30 s meter tick, even when meter is unreachable: at most
20 transactions of at most 500 ascending request IDs, each committing its
classifications and cursor together. Restarts resume from `after_id`. Inserts keep
existing rows; only unpriced → estimated updates, so a retry cannot reprice. When
a walk reaches `target_id`, a one-time check requires exactly one classification
per inference request and none for other endpoints. Only then is
`completed_at_ms` set. Until all families complete, usage warns
`costs: frozen request costs are backfilling; spend is incomplete`.
That check walks `requests` once with primary-key probes. It is the reviewed EQP
exception; pricing failures pause backfill with a `costs:` warning.

Rows unpriced only because no reference price existed set `unpriced_from_id`.
After a price is confirmed, the next poll rewinds that family's walk there and
turns complete-token unpriced rows into estimates. Spend rollups do not exist yet;
MET-205 must rewrite affected buckets in that transaction.

Usage reads the window via `requests_ts`, then walks one cost primary-key range
over the window's ID span, skipping rows outside the window. It sums frozen
priced/estimated nano-USD in Rust with checked i64 arithmetic. A probe per
request and family measured about 3× slower. `unpriced_requests` is inference
requests minus priced and estimated, including rows still being backfilled.
The JSON and OpenAPI shapes are unchanged; USD remains a presentation conversion.
Usage reads drop from 16 to 11; pricing stays 9. Requests setup is 116 statements.
The release `benchmark_100k` (100k requests, two families) measured usage p95
285–375 ms against 230–247 ms on main on the same orb. Frozen-cost reads replace
cheap in-memory pricing, and MET-205 rollups remove the raw-row scan.

The installer treats v4 like legacy: verified `.backup` snapshot, recorded version,
before/after row counts of every existing table, then an in-place migration as
`factory-api`. Rollback restores that verified v4 snapshot and the MET-203 binary,
**restoring all telemetry to the backup time**. It keeps displaced files. Snapshots
from older installers recorded `v4` without a version when no migration ran; they
restore no request data. No retention, rollups or pruning are added. No production
migration, deployment or production read has been run.

## Usage, spend and GPU history rollups implementation (MET-205)

MET-205 adds **meter v2** and **API `requests.db` v6** through the shared runner
(literal checksums `0xdefc08deaf53df27` / `0xbcc07fc3ad3e0747`). Both only add
tables and indexes; no existing row changes and the file is never replaced.
Runtime refuses older and newer versions with an offline-migration message.

Tables follow "Rollup tables and exact aggregation" exactly: STRICT, WITHOUT ROWID
`request_hourly`/`request_daily` in both databases, API `spend_hourly`/`spend_daily`
(FK to the matching request row), meter `gpu_hourly`, and `rollup_state` (meter
`requests` and `gpu` jobs; API one `requests` job). Latency histograms are
`request_latency_hourly`/`request_latency_daily`: PK
`(bucket_ms,dimension_key,scheme,bin)`, FK to the request row, positive counts.
Scheme 1 is fixed: below 8 µs one bin per microsecond; above, eight sub-bins per
power of two (bin = 8·(e−2)+m, at most 12.5% wide, bin ≤ 495), represented by the
bin midpoint. A new layout adds a scheme number. Covering
`requests_ts_latency` indexes let exact percentiles read only latency columns.

**Deviation:** `rollup_state` adds nullable `verified_at_ms`. Rows are created with
the first committed batch; `verified_at_ms` is set only after the comparison
below. Until then, reads ignore aggregates and read every row raw.

**Job.** A startup run, then every five minutes (meter maintenance tick; API
`database` collector), at most 20 transactions per job per run. Each transaction
selects at most 5,000 IDs above `last_id`, adds their hourly contributions
(checked integer sums, REAL TPS ratio sums), recomputes affected days from hours,
and advances the checkpoint. Late rows have higher IDs and update older buckets.
The API batch never passes a request whose classifications are still being
backfilled (`WaitingForCosts`). A failed, lagging or cost-blocked run sets meter
`/meter/health` `maintenance` to `unhealthy` or adds an API `rollups:` usage warning.
The next run resumes from the committed checkpoint; usage stays correct meanwhile.

**Publication.** When a job first catches up, one reviewed full comparison
runs before `verified_at_ms`. It checks every hour and day per dimension against
raw: request counts, token sums with NULL-aware known counts, TPS ratio sums/counts,
load sums and exact daily histograms. API spend is checked per hour, day, family,
dimension and status against `request_costs`. Every family also needs
priced+estimated+unpriced = inference requests in every request bucket. GPU hours
are compared from the first whole hour of retained raw samples, because v1 already
pruned at seven days. The offline migrations print these comparisons.

**Reads.** Each request runs in one read transaction. Daily rows cover whole UTC
days from the first day boundary, hourly rows the hours before it, and raw rows the
partial first hour plus every row above the verified checkpoint. The intervals are
disjoint by time and ID. Ranges ≤30d keep exact nearest-rank percentiles from the
covering index. New `365d` ranges (meter stats, API usage) merge histograms and
set additive `percentiles_approximate`. GPU history up to seven days stays raw;
the resolution is chosen from the request time the range was parsed at, so a
slow read cannot turn a 7d request into hourly means.
Longer ranges return hourly means (`samples` set; ts is the hour start) before
the first whole raw hour, then raw samples. Meter's existing seven-day GPU
deletion now removes only verified, rolled-up IDs. Request pruning followed in MET-206 (below).

**Fill-ins.** Cost backfill pages carry the rollup checkpoint in their page read.
A page containing rolled-up requests reads their prior statuses once. Unpriced →
estimated fill-ins, or a newly configured family's rows, then rewrite affected
hourly spend rows and recompute their days **in the same transaction**. Ordinary
pages keep MET-204's budget.

**Ingestion invariant.** API sync only inserts IDs above its cursor, and the
cursor is at least every cached ID, so no lower ID can appear at or below the
rollup checkpoint. Rows are plain inserts, so a known ID is never rewritten.

Measured budgets (enforced in tests): API usage **6** reads for every range,
replacing 11. Meter stats **3**, GPU history **≤2**, health/requests 1. A full
5,000-row API rollup batch is **≤16**. MET-230 consolidates the API pricing view:
pricing **2**, HTTP confirm **9**, refresh view reads **4**, meeting the step-5
targets (≤3 / ≤12 / ≤6 view reads). The view batches indexed selection and rate
lookups for all configured families and omits pending rates, which the API does
not return. No schema or pricing-service change is needed.
Sync pages keep MET-204's budget.
A rewinding cost page adds at most one status read and three rewrite statements
when its rows are already rolled up. Requests setup is 132 statements (116).

Release `benchmark_100k` on one host: usage 30d p95 **275 ms** at the merge base;
on this branch **352 ms** before the first rollup run, **45 ms** rolled up, and
365d **11 ms**. The 200 ms bound now applies to the rolled-up state, which the
startup run reaches. Exact ≤30d percentiles still read 100k latency index entries.
A 100k-row backfill takes one bounded run of 20 batches plus verification.

Sandbox (100k seeded rows): baseline v1/v5 data from the merge-base binaries was
stopped, copied and migrated offline. Meter v1→v2 backfilled 100,520 rows
(requests plus GPU) in 935 ms; API v5→v6 backfilled 100,150 rows in 1,350 ms.
All existing table counts were unchanged and both comparisons were equal. Old and
new code on the same files at a fixed instant gave equal JSON values after
normalization: `generated_at_ms` removed and the new `percentiles_approximate:
false` stripped. That is not literal byte equality.
That covers usage and spend (24h/7d/30d), meter stats (with and without a model
filter) and GPU history sample totals. The branch stack then ran on the migrated
files with `maintenance` ok and advanced on its five-minute tick.

**Installers.** `install-meter.sh [--check-only] <binary>` verifies the schema
read-only. For v1 it stops meter, checkpoints, makes and verifies the MET-74
archive, and copies the stopped generation into the snapshot. It records the old
version, then upgrades in place, comparing requests/GPU/drop-episode counts. It
then requires v2 and two verified rollup jobs. `install-factory-api.sh` treats v5
like v4: verified `.backup`, recorded version, every-table counts before and after,
then `migrate --requests-db`. It requires v6 and, with costs complete, verified
rollups through the latest ID. Rollbacks restore those verified v1/v5 snapshots
(**all telemetry returns to backup time**). Reruns on v2/v6 restore no DB. No
production migration, deployment or production read has been run.

Sandbox launcher: `scripts/sandbox-shims/runtime.py` starts meter on v2. A reused
v1 `meter.db` is upgraded in place by `meter migrate --db` (log in
`.sandbox/meter-upgrade.json`); a failed upgrade stops startup with a clear
message. A reused pre-MET-205 requests cache (v5) still needs the offline
`factory-api migrate --requests-db`; the API refuses it with that instruction.

## Gated raw request retention implementation (MET-206)

MET-206 adds no schema change: meter stays v2 and API `requests.db` stays v6.
Meter's seven-day GPU deletion (`rollup::prune_gpu`, MET-205) is unchanged.

**Jobs.** Meter runs request retention after each rollup run on its maintenance
tick (startup, then every five minutes). factory-api runs it after `roll_up` on
the `database` collector (same schedule). Each run uses `cutoff = now - 365 days`
and deletes requests with `ts_ms < cutoff`. A row at exactly the cutoff is kept,
which matches the inclusive start of the `365d` range. A run is at most 50
transactions of at most 2,000 requests. Each transaction is its own writer job,
so ingestion and sync writes run between batches. A refused batch commits
nothing.

- **Meter prunes only from its lowest ID upward.** A batch reads the 2,000
  lowest IDs (a rowid walk), keeps the run that is expired and at or below the
  verified checkpoint, and deletes `id <= end` of that run. The first newer row
  ends the run. So every ID below meter's oldest stored ID was removed by
  retention, and no ID above it ever is. Meter assigns IDs at request time, so
  in practice this is every expired row. An expired row above a newer one (an
  import with old timestamps) waits until the run reaches it.
- **factory-api prunes every expired row.** A batch reads the highest expired
  ID E through `requests_ts`, checks every gate against E, then deletes up to
  2,000 expired rows with `id <= E`. Holes in the API copy do not affect sync.
  Deletes cascade to `request_costs`.
 The jobs never modify rollups,
spend rollups, `rollup_state`, `cost_backfill`, `sync_state` or warnings.

| Gate | Meter | factory-api | Reason prefix |
| --- | --- | --- | --- |
| Rollup verified | `rollup_state` `requests` has `verified_at_ms` | Same, API job | `rollup unverified` |
| Rollup covers the rows | Lowest stored ID, when expired, `<= last_id` (the run stops at `last_id`) | `last_id >= E` | `rollup behind` |
| Backfill complete | — | Every configured family has `completed_at_ms` | `backfill incomplete` |
| Costs frozen | — | Per family: no walk pending at or below E (`after_id >= target_id` or `after_id >= E`) and `unpriced_from_id` is NULL or above E | `costs not frozen` |

factory-api joins every unmet reason with `; `. A late row that is older than
the cutoff but above the checkpoint gives `rollup behind`, and pruning waits
until a rollup run includes it. Because retention runs right after a rollup
run, this normally clears in the same tick.

Reads do not change after a prune. Rollups keep every request. The raw part of
a range needs only rows with `ts_ms >= since` or `id > checkpoint`. Here `since`
is the request time minus the range, which is never earlier than any past
prune's cutoff. Rows above the checkpoint are never pruned. Ranges up to 365 days,
spend totals and exact ≤30-day percentiles are therefore identical. Only
non-public reads before the 365-day window, such as `since=0` exact
percentiles, lose raw rows.

**Health.** Meter `/meter/health` `maintenance.retention` and factory-api
`/v1/health` `retention` have the same fields:

| Field | Meaning |
| --- | --- |
| `status` | `pending` before the first run; `ok`; `skipped` (a gate is unmet); `failed` (job error, rows intact) |
| `detail` | Skip reasons or error; for a full run, a note that pruning continues next run |
| `checked_at_ms`, `cutoff_ms` | Last run and its strict cutoff |
| `oldest_retained_id` | Lowest stored request ID after that run; null when empty |
| `pruned_at_ms`, `pruned_rows` | Last run that was allowed to prune, and the rows it deleted (including 0) |
| `pruned_rows_since_start` | Rows deleted since the process started |
| `skipped_since_ms` | Start of the current streak of skipped or failed runs |

Meter `maintenance.status` still reports only the rollup job. A failed batch
rolls back, the job records `failed` with the error, and the next run retries.
The `retention:api` and `retention:meter` warning alerts open when
`skipped_since_ms` is at least 24 hours old (see `docs/alerts.md`). The API
reads meter's state from `/meter/health` on each 30-second alert cycle. An
unreadable meter keeps an open alert open. The streak is held in memory, so a
restart restarts the 24-hour clock.

**Sync.** Meter cursor pages (`after_id`) add header `oldest_retained_id`. It is
`MIN(id)` from the page's own statement, so the budget stays one statement per
page. Because meter prunes only from its lowest ID, the header is exact. It is absent on empty pages and in newest-first mode. When the API sees
IDs `previous+1..id-1` missing, IDs below the oldest retained ID were pruned by
retention. Only `max(previous+1, oldest)..id-1` raises the existing
`gap: meter ids a..b` warning. A page whose oldest ID is above its first row is
invalid: nothing is written and the cursor stays. A meter without the header
keeps the earlier behavior. The API cursor is the persisted
`sync_state.last_after_id` (MET-203), not `MAX(id)`, so pruning the API copy
never moves it (the C1 hazard). Rows that meter pruned before the API fetched
them are also missing from the API's rollups. That requires an API outage of
more than 365 days.

**Budgets.** Meter: 3 data statements per deleting batch (lowest-ID walk, rollup
state, DELETE), one walk for the batch that stops, plus one `MIN(id)` read per run. factory-api: 4 per batch (adds the cost
state read) plus one. Usage, stats, health and sync budgets are unchanged.

**Limits.**

- Offline `meter migrate --db` on v2 and `factory-api migrate --requests-db` on
  v6 rerun the full raw comparison (`factory_db::rollup::verify`). After
  retention prunes rows, that comparison fails. Installers do not run these
  commands on v2/v6. A future migration that re-verifies must compare from the
  retained boundary, as GPU verification does.
- Sandbox finding (2026-10-23): with per-row pruning, meter left holes above
  rows it kept. The API had not fetched those rows yet, so it reported 4,386
  pruned IDs as gaps. Pruning only from the lowest ID removes that case.
- A reference family added after pruning is classified only for retained rows,
  so older buckets lack it. Pruned unpriced rows stay unpriced, as decided.
- Pruned rows are recoverable only from MET-74 backups taken before the prune.
  No VACUUM runs; SQLite reuses freed pages.

Sandbox (2026-10-23, `scripts/sandbox`): meter's 1k seed requests were replaced
by 150,000 synthetic requests over 400 days in ID order (13,126 expired). At
startup, before the rollups had caught up, meter recorded `rollup unverified` and
the API `rollup behind`. On the five-minute tick each side pruned 13,127 rows.
Meter's oldest retained ID went 1028 → 14155. The API, whose cursor (1018) was
already below meter's oldest ID, synced to 151027 with no new gap warning. Only
the three real seed gaps remained. At one fixed instant, meter stats and API
usage and spend (both families) for 24h/7d/30d/365d equaled the pre-prune copy
plus the rows that arrived later.

Tests: `meter/tests/rollups.rs` and `factory-api/tests/rollups.rs` cover the
strict cutoff, each gate, late rows, failure, restart idempotence and identical
public ranges on a 400-day fixture. `factory-api/tests/cache_recovery.rs` covers
sync past meter's pruning and a real gap. The `alerts` unit tests cover the
24-hour threshold.

## Legacy schemas

The version-zero schemas that migrations upgrade from or archive. Runtime refuses
these versions.

### Factory-api cache schema

```sql
CREATE TABLE requests(id INTEGER PRIMARY KEY, ts_ms INTEGER NOT NULL, record TEXT NOT NULL);
CREATE INDEX requests_ts ON requests(ts_ms);
CREATE TABLE warnings(message TEXT PRIMARY KEY);
```

`record` is RequestRecord JSON, including ID. `ts_ms` duplicates its `ts` without
a consistency constraint. IDs come from meter. `MAX(id)` is the persisted sync
watermark; there is no separate checkpoint. Neither table has retention. A
non-STRICT TEXT primary key does not imply NOT NULL in this rowid table.
Cache rows were mutable upserts. MET-203 archives these tables as
`requests_before_v4` and `warnings_before_v4`.

### Pricing schema

```sql
CREATE TABLE refreshes (fetched_at INTEGER NOT NULL);
CREATE TABLE price_snapshots (
  fetched_at INTEGER NOT NULL, source TEXT NOT NULL, model_id TEXT NOT NULL,
  input_per_mtok REAL NOT NULL CHECK(input_per_mtok >= 0),
  output_per_mtok REAL NOT NULL CHECK(output_per_mtok >= 0), released_at INTEGER,
  refresh_id INTEGER NOT NULL
);
CREATE INDEX snapshot_lookup ON price_snapshots(model_id, fetched_at);
CREATE TABLE reference_selection (
  family TEXT NOT NULL, model_id TEXT NOT NULL, effective_from INTEGER NOT NULL,
  confirmed INTEGER NOT NULL CHECK(confirmed IN (0,1)), refresh_id INTEGER NOT NULL
);
CREATE INDEX selection_lookup ON reference_selection(family, effective_from);
CREATE TABLE pricing_items (
  fetched_at INTEGER NOT NULL, kind TEXT NOT NULL, family TEXT NOT NULL,
  message TEXT NOT NULL, refresh_id INTEGER NOT NULL
);
```

All pricing timestamps are UTC **seconds**; rates are REAL USD/Mtok. Tables use
implicit rowids for refresh identity and tie-breaking. `refresh_id` has no FK.
All writes append; confirmation adds a row rather than mutating the candidate.
The most recent refresh determines actionable pending choices. Rate changes for
the active model take effect at fetch time; confirmation is only for model changes.
Cost does not use a future observation. Equal fetch times prefer later refresh,
then OpenRouter, then later rowid. Pricing v1 moves this file aside as
`pricing.v0.db` and never converts its rows.

## Target schema contract

The definitions below are the schema contract the migrations implement. Every application table ends in STRICT, with explicit column types,
NOT NULL for required values, CHECKs for enums/ranges, and declared PK/FK IDs.
SQLite's own `sqlite_sequence`, statistics and schema tables are internal exceptions.
All UTC timestamps are INTEGER `*_ms`. Nonnegative durations remain exact INTEGER
`*_ns` where supplied by Ollama, **not timestamps**; latency and physical telemetry
can be REAL. Keep duration conversion at the presentation/aggregation boundary,
so migration does not truncate sub-millisecond durations or change TPS.

### Raw facts: meter and cache

Both databases use this column contract for `requests`; meter alone adds
AUTOINCREMENT, while cache inserts the meter-supplied ID. Do not add a second
copy of the entire RequestRecord JSON. Serialize the legacy wire contract from
typed columns; keep only upstream's otherwise-unmodeled usage JSON.

```sql
CREATE TABLE requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms INTEGER NOT NULL CHECK(ts_ms>=0), endpoint TEXT NOT NULL, model TEXT,
  prompt_eval_count INTEGER CHECK(prompt_eval_count>=0),
  eval_count INTEGER CHECK(eval_count>=0),
  load_duration_ns INTEGER CHECK(load_duration_ns>=0),
  prompt_eval_duration_ns INTEGER CHECK(prompt_eval_duration_ns>=0),
  eval_duration_ns INTEGER CHECK(eval_duration_ns>=0),
  total_duration_ns INTEGER CHECK(total_duration_ns>=0),
  usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
  latency_ms REAL NOT NULL CHECK(latency_ms>=0),
  status INTEGER NOT NULL CHECK(status BETWEEN 100 AND 999),
  stream INTEGER NOT NULL CHECK(stream IN (0,1)), error TEXT,
  client_ip TEXT NOT NULL, client_hostname TEXT NOT NULL,
  user_key TEXT CHECK(user_key IS NULL OR length(user_key)>0),
  actor_kind TEXT NOT NULL DEFAULT 'unattributed'
    CHECK(actor_kind IN ('human','agent','unattributed')),
  CHECK((user_key IS NULL AND actor_kind='unattributed') OR
        (user_key IS NOT NULL AND actor_kind IN ('human','agent')))
) STRICT;
CREATE INDEX requests_ts ON requests(ts_ms);
CREATE INDEX requests_model_ts ON requests(model,ts_ms);
CREATE INDEX requests_user_ts ON requests(user_key,actor_kind,ts_ms);
```

Validate u64 token/duration values against signed i64 before storage; reject and
report overflow rather than wrap. Backfill historical users to NULL/unattributed;
MET-89 later supplies trusted attribution, not arbitrary unvalidated headers.
Meter retains all endpoints; API usage filters the current inference allowlist.
API copy uses identical columns/checks/indexes except no AUTOINCREMENT. This is a
replicated schema contract, not permission for factory-api to mutate meter.

Meter `gpu_samples`: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `ts_ms INTEGER NOT NULL
CHECK(ts_ms>=0)`, `gpu_index INTEGER NOT NULL CHECK(gpu_index>=0)`; nonnegative
REAL NOT NULL `memory_used_mib`, `memory_total_mib`, `power_w`; REAL NOT NULL
`utilization_percent CHECK(... BETWEEN 0 AND 100)`, `temperature_c`. STRICT.
Indexes: `(ts_ms)` for all-GPU retention/history and `(gpu_index,ts_ms,id)` for
physical-GPU history. Remove duplicate sample JSON, keep wire `ts` compatibility.

Meter v1 also owns STRICT `drop_episodes`: `id INTEGER PRIMARY KEY AUTOINCREMENT`,
`started_at_ms`, `ended_at_ms`, `dropped_requests`, `dropped_gpu_samples`, all
INTEGER NOT NULL with nonnegative CHECKs and `ended_at_ms>=started_at_ms`.
One row records each overflow episode after the bounded 1,024 writer queue drains.
Health exposes process-lifetime request/GPU drop counters and queue depth while
status remains `ok`; warnings are rate-limited. Episodes are retained indefinitely.
factory-api and factory-status warning presentation follows separately.

API `sync_state`: `id INTEGER PRIMARY KEY CHECK(id=1)`, `last_after_id INTEGER NOT
NULL CHECK(last_after_id>=0)`, `synced_at_ms INTEGER NOT NULL CHECK(synced_at_ms>=0)`.
STRICT singleton, initialized to zero for migration 3's empty rebuild, not
recalculated after pruning. Commit cache rows and cursor in one transaction; emit SSE only afterward.
Use ascending cursor pages and a bounded catch-up loop. Numeric ID discontinuities
are diagnostic, not conclusive proof of lost committed rows after AUTOINCREMENT;
meter must expose its oldest retained ID for retention-loss detection (MET-206:
`oldest_retained_id` on cursor pages). A restored
meter whose maximum ID is below the API cursor requires explicit reconciliation,
not automatic cursor advancement or silently treating it as an empty page.
Before costs/rollups activate, backfill missing retained history using cursor
pages starting at `after_id=0`; a legacy MAX(id) checkpoint alone does not recover
old gaps. After activation, reject a newly discovered lower ID
at or below the rollup checkpoint from normal sync and require explicit aggregate
reconciliation. Higher-ID late timestamps are handled by the normal job. Do not
silently insert lower-ID backfill that an ID checkpoint would never aggregate.

API `warnings`: `message TEXT PRIMARY KEY`, `first_seen_ms INTEGER NOT NULL`,
`last_seen_ms INTEGER NOT NULL`, `resolved_at_ms INTEGER`; all nonnegative UTC times,
STRICT. Existing gap strings get migration time for first/last observation and
NULL resolution; don't invent past dates. Index `(resolved_at_ms,last_seen_ms)`.
Unresolved coverage gaps stay visible; resolve only after verified backfill or
operator acknowledgement, never automatically on a successful new poll.

### Pricing v1: rebuild empty, preserve the legacy file

Migration 1 creates this schema only on an empty database via `factory-db`.
The installer stops factory-api, verifies a SQLite backup, and moves the old
file and WAL/SHM to `pricing.v0.db`. It never copies legacy rows or deletes the
old file. It runs `factory-api migrate --pricing-db <path>` as `factory-api`
before starting the new binary. A rerun on v1 does not rebuild. Both API startup
and the pricing CLI refuse any version other than v1; runtime opens perform no
pricing DDL. A populated version-zero file is refused without writes, not
adopted by fingerprint. After startup, refresh once and confirm both families.

```sql
CREATE TABLE refreshes (
  id INTEGER PRIMARY KEY, fetched_at_ms INTEGER NOT NULL CHECK(fetched_at_ms>=0)
) STRICT;
CREATE INDEX refreshes_time ON refreshes(fetched_at_ms);
CREATE TABLE price_snapshots (
  id INTEGER PRIMARY KEY, refresh_id INTEGER NOT NULL REFERENCES refreshes(id),
  fetched_at_ms INTEGER NOT NULL CHECK(fetched_at_ms>=0),
  source TEXT NOT NULL CHECK(source IN ('openrouter','litellm')), model_id TEXT NOT NULL,
  input_micro_usd_per_mtok INTEGER NOT NULL CHECK(input_micro_usd_per_mtok>=0),
  output_micro_usd_per_mtok INTEGER NOT NULL CHECK(output_micro_usd_per_mtok>=0),
  released_at_ms INTEGER CHECK(released_at_ms>=0)
) STRICT;
CREATE INDEX snapshot_lookup ON price_snapshots(
  model_id,fetched_at_ms DESC,refresh_id DESC,(source='openrouter') DESC,id DESC);
CREATE INDEX snapshot_earliest ON price_snapshots(
  model_id,fetched_at_ms,refresh_id,(source='openrouter') DESC,id DESC);
CREATE INDEX snapshot_release ON price_snapshots(model_id,released_at_ms DESC);
CREATE INDEX snapshot_refresh ON price_snapshots(refresh_id);
CREATE TABLE reference_selection (
  id INTEGER PRIMARY KEY, family TEXT NOT NULL, model_id TEXT NOT NULL,
  effective_from_ms INTEGER NOT NULL CHECK(effective_from_ms>=0),
  confirmed INTEGER NOT NULL CHECK(confirmed IN (0,1)),
  refresh_id INTEGER NOT NULL REFERENCES refreshes(id)
) STRICT;
CREATE INDEX selection_lookup ON reference_selection(
  family,confirmed,effective_from_ms DESC,id DESC);
CREATE INDEX selection_confirmed_id ON reference_selection(family,id DESC) WHERE confirmed=1;
CREATE INDEX selection_pending ON reference_selection(family,refresh_id,effective_from_ms DESC,id DESC)
  WHERE confirmed=0;
CREATE INDEX selection_time ON reference_selection(effective_from_ms);
CREATE INDEX selection_refresh ON reference_selection(refresh_id);
CREATE TABLE pricing_items (
  id INTEGER PRIMARY KEY, refresh_id INTEGER NOT NULL REFERENCES refreshes(id),
  fetched_at_ms INTEGER NOT NULL CHECK(fetched_at_ms>=0),
  kind TEXT NOT NULL CHECK(kind IN ('warning','pricing.changed')),
  family TEXT NOT NULL, message TEXT NOT NULL
) STRICT;
CREATE INDEX items_refresh ON pricing_items(refresh_id,id);
```

No legacy identities or rates are converted. New history uses explicit IDs for
same-millisecond ties and pending withdrawal, preserving the selection semantics.
Foreign keys are database-local; model IDs are external feed identifiers.
API history reads use pricing's public library. `snapshot_earliest` covers the
mixed ascending-time/descending-source earliest fallback; hot rate queries name
their matching index because bundled SQLite otherwise sometimes chooses the
opposite time order and adds a temporary sort. EXPLAIN tests require no such sort.

Money rules:

- Pricing does not convert legacy REAL money and has no rounding report.
  Feed parsing uses decimal strings/JSON numeric lexemes with checked integer
  scaling by 10^12 from USD/token to micro-USD/Mtok, never an intermediate f64.
  Negative, nonfinite, out-of-range and fractional-micro-unit rates are rejected;
  trailing decimal zeroes and exponent notation retain their exact values.
- For each complete-token request and family, compute numerator using checked
  i128: `prompt_tokens * input_micro_usd_per_mtok + output_tokens * output_micro_usd_per_mtok`.
  Cost is `(numerator + 500) / 1000` nano-dollars, half-up **once per request**,
  then checked into i64. Sum those stored nano-dollars, not rounded aggregate tokens.
  Sum with checked arithmetic; overflow fails visibly, never saturates.
- Example: rates 2,000,000/8,000,000 micro-USD/Mtok and tokens 3/7 give numerator
  62,000,000 and cost **62,000 nano-USD**. At 1,500 micro-USD/Mtok, one input
  token costs **2 nano-USD** after rounding; two such requests total **4**, not 3.
  Zero cost is not an unpriced row.
- SQL CHECKs enforce signed ranges/nonnegativity; STRICT alone still permits
  lossless type coercion. Trust-boundary validation rejects wrong units/types.
  Preserve HTTP USD fields as presentation-only conversions of integer totals;
  introduce explicit integer fields when versioning the public contract. Pricing
  CLI retains numeric `--at` seconds compatibility via explicit ×1000 parsing,
  adds an unambiguous `--at-ms`, and keeps RFC3339 timezone requirements. Library
  arguments/field names become `*_ms`, with no magnitude-based unit guessing.

### Frozen per-request costs (API owns, pricing supplies rates)

API `request_costs`, STRICT:

| Columns | Contract |
| --- | --- |
| `request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE`, `family TEXT NOT NULL` | PRIMARY KEY(request_id,family), one classification per inference request per reference family |
| `priced_at_ms INTEGER NOT NULL CHECK(priced_at_ms>=0)` | Actual time that classification is frozen, separate from event time |
| `cost_status TEXT NOT NULL CHECK(cost_status IN ('priced','estimated','unpriced'))` | Preserve distinct estimates and missing prices/tokens |
| `cost_nano_usd INTEGER CHECK(cost_nano_usd>=0)` | NOT NULL for priced/estimated, NULL for unpriced; table CHECK enforces both directions |
| `selection_id INTEGER`, `snapshot_id INTEGER`, `reference_model_id TEXT` | Cross-DB provenance, not SQLite FKs; present for priced/estimated classifications, NULL for unpriced |
| `input_micro_usd_per_mtok INTEGER`, `output_micro_usd_per_mtok INTEGER` | Freeze nonnegative rates with priced/estimated row; NULL only when unpriced |

Index `(family,request_id)` supports backfill/reporting; request PK supports
batch reads/cascades. Effective selection/rate are evaluated at **request.ts_ms**,
not priced_at_ms. Pre-history rows use earliest-confirmed/earliest-observed
fallback and are explicitly estimated; missing either token count is unpriced.
Read pricing history in one read transaction, then write cache/costs locally in
one transaction. Immutable observed history plus stored rates/provenance avoids
a cross-database write transaction. Retried upserts must not reprice a frozen row.
If initial ingestion cannot read pricing due to a storage failure, do not advance
the cursor; a genuine absence of history is an unpriced classification.

Migration backfill freezes legacy classifications using the current history;
new ingestion freezes once. Priced and estimated rows are frozen. The only
allowed transition is `unpriced` to `estimated`, while the raw request remains,
in a separate fill-in job after a reference price is confirmed, matching today's
pre-history behavior. That job rewrites affected `spend_hourly`/`spend_daily`
buckets in the same transaction. After pruning, the row remains unpriced in
rollups. Any other rewrite requires a separate versioned restatement design.

### Rollup tables and exact aggregation

Meter owns usage/GPU rollups. API owns usage and spend rollups computed from its
copy; it never writes meter or pricing tables. API gaps remain warnings even
when a time bucket has no rows. No caching server or persisted fleet state is needed.

`request_hourly` and `request_daily` exist in **both** meter and API. Each is
STRICT, with the same columns; only bucket width differs:

| Columns | Contract |
| --- | --- |
| `bucket_ms INTEGER NOT NULL CHECK(bucket_ms>=0)` | UTC floor to 3,600,000 or 86,400,000 ms; CHECK modulo width = 0 |
| `dimension_key TEXT NOT NULL`, `endpoint TEXT NOT NULL`, `model TEXT`, `user_key TEXT`, `actor_kind TEXT NOT NULL` | Dimension key is `json_array(endpoint,model,user_key,actor_kind)` with equality CHECK; same actor/user CHECK as raw |
| `requests INTEGER NOT NULL`, `input_tokens INTEGER NOT NULL`, `output_tokens INTEGER NOT NULL`, `input_known_count INTEGER NOT NULL`, `output_known_count INTEGER NOT NULL` | Nonnegative counts/sums; distinguish unknown tokens from known zero |
| `prompt_tps_sum REAL NOT NULL`, `prompt_tps_count INTEGER NOT NULL`, `generation_tps_sum REAL NOT NULL`, `generation_tps_count INTEGER NOT NULL` | Sum per-request ratios only for known tokens and positive duration; avg = sum/count, not pooled tokens/duration |
| `total_load_ns INTEGER NOT NULL`, `load_known_count INTEGER NOT NULL` | Nonnegative checked sum/count, no invented load samples |

PRIMARY KEY `(bucket_ms,dimension_key)`; indexes `(model,bucket_ms)` and
`(user_key,actor_kind,bucket_ms)`. JSON array keys make NULL, empty string, and
literal `"unattributed"` distinct without a nullable composite-PK duplicate bug.
Keep endpoint as a dimension so API can filter inference while meter counts all.
No per-hour averages may be averaged without their counts. Guard INTEGER sums
against SQLite overflow; REAL telemetry/TPS sums are not money.

API `spend_hourly` and `spend_daily`, STRICT: `bucket_ms INTEGER NOT NULL`,
`dimension_key TEXT NOT NULL` (same checked dimension columns as request rollups),
`family TEXT NOT NULL`, `priced_nano_usd INTEGER NOT NULL`,
`estimated_nano_usd INTEGER NOT NULL`, `priced_requests INTEGER NOT NULL`,
`estimated_requests INTEGER NOT NULL`, `unpriced_requests INTEGER NOT NULL`.
All sums/counts nonnegative; bucket alignment CHECK. PK
`(bucket_ms,family,dimension_key)`; indexes `(family,bucket_ms)` and
`(user_key,actor_kind,bucket_ms,family)`. Aggregate frozen request costs only;
priced+estimated+unpriced counts must equal inference requests per family/dimension.
Reference families are alternatives: never sum them into one total spend figure.

Meter `gpu_hourly`, STRICT: PK `(bucket_ms,gpu_index)` with aligned nonnegative
INTEGER bucket and nonnegative INTEGER GPU index; `samples INTEGER NOT NULL
CHECK(samples>0)`, `last_sample_ms INTEGER NOT NULL`. For each of
`memory_used_mib`, `memory_total_mib`, `utilization_percent`, `temperature_c`,
`power_w`, store REAL NOT NULL suffix columns `_sum`, `_min`, `_max`, `_last`.
Average = sum/samples; `_last` comes from greatest `(ts_ms,id)`, not insertion order.
Index `(gpu_index,bucket_ms)` for per-GPU history. Missing cycles contribute no
samples, never zero measurements. Hourly telemetry summarizes measurements,
not time-weighted energy; irregular sampling must not be described as kWh.

Each rollup-owning DB has STRICT `rollup_state`: `job TEXT PRIMARY KEY`,
`last_id INTEGER NOT NULL CHECK(last_id>=0)`, `updated_at_ms INTEGER NOT NULL
CHECK(updated_at_ms>=0)`. Meter has separate request/GPU rows; API one request
row for metrics and costs together. Initialize only when aggregates are built,
not merely when schema is created.

**Percentile boundary:** exact nearest-rank p50/p95 comes from raw rows within
the 365-day window, so current ≤30-day endpoints remain exact. Hourly rollups
carry a mergeable fixed-bucket latency histogram; daily rollups sum hourly
histograms. Ranges outside raw retention use approximate percentiles and the
contract flags them as approximate. Bucket boundaries and storage layout are
deferred to step 5; they must be fixed, versioned and additive.

### Retention and job transaction rules

| Database/table | Retention | Delete/aggregation gate |
| --- | --- | --- |
| meter + API `requests` | 365 days raw | `ts_ms < now_ms - 365*86400000`, only IDs included in the verified rollup; API also needs complete, frozen costs (MET-206) |
| API `request_costs` | Same 365 days as parent | Cascades with its request, only after spend rollups include every family classification (MET-206) |
| Both `request_hourly`, `request_daily`; API `spend_hourly`, `spend_daily` | Indefinite | No scheduled deletion; late arrivals correct affected buckets |
| meter `gpu_samples` | Seven days raw | Same strict `<` cutoff; only committed rolled-up IDs |
| meter `gpu_hourly` | Indefinite | No scheduled deletion |
| pricing `refreshes`, `price_snapshots`, `reference_selection`, `pricing_items` | Indefinite append-only | Historical rate/selection provenance must remain valid; index latest items instead of deleting |
| API `warnings` | Unresolved indefinitely; resolved 365 days after resolution | Scheduled indexed cleanup; acknowledgment must be explicit |
| API `sync_state`, both `rollup_state` | Indefinite singleton/checkpoint rows | Replace state atomically; never time-prune |

Scheduled rollup/retention cycle every five minutes plus startup catch-up, bounded
to 5,000 input rows per transaction with rescheduling until caught up. Acquire
writer once: select `id > last_id` batch, aggregate its contributions into hourly
rows, recompute affected daily rows from hourly rows, then advance checkpoint
**in the same transaction**. Crash/retry cannot apply a batch twice. Late event
timestamps still have higher IDs, so they update prior buckets/days. Never use
MAX(timestamp) as the ingestion checkpoint. API raw upserts of known immutable
meter IDs cannot change previously rolled-up facts; detect unexpected changed
payloads and require reconciliation rather than silently corrupting summaries.

Then prune eligible rolled-up rows in bounded chunks. Failures, incomplete cost
backfill or rollup lag stop pruning; a failed job surfaces unhealthy maintenance
status, not a successful empty report. Day boundaries are UTC, independent of
America/New_York/DST. Combine daily interior, hourly remainder and raw partial
hours with disjoint half-open `[start,end)` intervals; no double counting at edges.
Read the rollup checkpoint and aggregates in the same read snapshot. Include
unrolled raw rows (`id > last_id`) even when their timestamps fall in an interior
hour/day; those rows are not yet in aggregates. Raw edge fragments and unrolled
rows must also be disjoint by ID. A five-minute job must not make usage silently
omit the latest five minutes or a late arrival.
Public inclusive cutoffs must translate without excluding an exact-boundary row.
Run optimize/checkpoint maintenance outside ingestion transactions. No VACUUM
on every cycle; deletion reuses pages, and file compaction is an explicit
backup-gated maintenance operation. Meter retention can outlive disconnected
API sync only for 365 days: advertise oldest retained ID and warn on lost coverage.
