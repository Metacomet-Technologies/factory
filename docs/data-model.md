# Factory data model: audit and migration design

Contributes to [MET-92](https://linear.app/metacomet/issue/MET-92/data-model-audit-enforced-db-standards-migrations-indexes-no-n1),
steps 1–2 only. Audited on factory-gpu, 2026-10-11, against main after PR #13.
This document specifies later implementation; **no migrations, shared DB crate,
retention changes, or new enforcement tests ship in this PR**. The Database rules
in `AGENTS.md` are requirements for that implementation, not a claim of existing CI coverage.

## Scope, evidence, and decisions

Sources read: root `README.md`; `meter/src/{db,lib,main,telemetry,usage}.rs`;
`factory-api/src/{data,lib,api,fleet,main}.rs`; `pricing/src/{lib,main}.rs`, its
README/config/tests; `shared/src/{lib,factory_api}.rs`; workspace tests and
MET-74 backup scripts. SQL discovery checked every SELECT/INSERT/DELETE and
connection open in these three database-owning crates.

Devon's captured schemas are all present on factory-gpu. No console access or
paste is needed. They are read-only inputs, **not database files**:

| Capture | SHA-256 |
| --- | --- |
| `/tmp/live-schemas/factory-gpu-meter.sql` | `e75e3e70fffa58d15832577345618cdde44e0630bab27af05eed4dbcfd8bf959` |
| `/tmp/live-schemas/factory-console-requests.sql` | `6ed803d0d7ea6bd92caababa93d45f10c12c6bf535800b487651d6b89ba94b36` |
| `/tmp/live-schemas/factory-console-pricing.sql` | `58ccd72af148e81a018aa895c376935636fb1fb5cd5aee3357e01b2314bf76f1` |

The captures match source DDL, including indexes, generated columns and lack of
STRICT. They do not establish row counts, `user_version`, live PRAGMAs, actual
SQLite version, data validity, or deployed binary version. None was queried live.

Decisions that later PRs must preserve:

- SQLite remains. No Valkey/Redis, no partitioning. Escalation is Postgres only
  after measured SQLite limits; this plan does not introduce it.
- Raw requests: 365 days in meter and its API copy. Request hourly **and daily**
  rollups: indefinite. Freeze each request's reference cost at pricing time;
  never reprice an old rollup using today's rate.
- GPU: seven days raw, hourly rollups indefinitely.
- Migrate pricing now: UTC INTEGER milliseconds; INTEGER micro-dollars per Mtok
  for rates; and INTEGER nano-dollars for per-request costs and totals.
  Floating-point money must not enter stored values or totals.
- MET-89 readiness: `user_key` and `actor_kind` (`human`, `agent`, `unattributed`).
  Unknown identity is NULL plus `unattributed`; hostnames are not user identities.
- MET-90 phase 1 remains independent and precedes implementation. Its phase 2
  snapshots can consume the rollups after MET-92 step 5.

The query inventory and measured plans reflect main after PR #13. PR #15 since
removed usage's pricing N+1 and added a factory-api pool and indexes. Step 3
re-baselines budgets against current main.

## Current databases and ownership

There are three logical SQLite databases; `shared` owns only serde/utoipa
contracts and has no SQLite state. Pricing CLI's configurable `./pricing.db`
is another instance of the **same pricing schema**, not a fourth schema.

| Database | Owner/location | Current persistence |
| --- | --- | --- |
| meter | meter, factory-gpu, `/srv/factory/meter/meter.db` | Raw request facts, GPU samples |
| API cache | factory-api, factory-console, `/var/lib/factory-api/requests.db` | Synced meter rows and permanent gap-warning strings |
| pricing | pricing library/CLI, factory-console, `/var/lib/factory-api/pricing.db` | Append-only observed prices, selections and refresh events |

Fleet, live GPU state, collector warnings and SSE fan-out are in memory in
`AppState`, not fleet/state tables. Fleet config is TOML. No schema should be
invented for them during this migration.

### Meter schema

Equivalent to the capture (generated-column order is the source's order):

```sql
CREATE TABLE requests (
  id INTEGER PRIMARY KEY, record TEXT NOT NULL,
  ts GENERATED ALWAYS AS (json_extract(record, '$.ts')) STORED,
  endpoint GENERATED ALWAYS AS (json_extract(record, '$.endpoint')) STORED,
  model GENERATED ALWAYS AS (json_extract(record, '$.model')) STORED,
  prompt_eval_count GENERATED ALWAYS AS (json_extract(record, '$.prompt_eval_count')) STORED,
  eval_count GENERATED ALWAYS AS (json_extract(record, '$.eval_count')) STORED,
  load_duration GENERATED ALWAYS AS (json_extract(record, '$.load_duration')) STORED,
  prompt_eval_duration GENERATED ALWAYS AS (json_extract(record, '$.prompt_eval_duration')) STORED,
  eval_duration GENERATED ALWAYS AS (json_extract(record, '$.eval_duration')) STORED,
  total_duration GENERATED ALWAYS AS (json_extract(record, '$.total_duration')) STORED,
  usage GENERATED ALWAYS AS (json_extract(record, '$.usage')) STORED,
  latency_ms GENERATED ALWAYS AS (json_extract(record, '$.latency_ms')) STORED,
  status GENERATED ALWAYS AS (json_extract(record, '$.status')) STORED,
  stream GENERATED ALWAYS AS (json_extract(record, '$.stream')) STORED,
  error GENERATED ALWAYS AS (json_extract(record, '$.error')) STORED,
  client_ip GENERATED ALWAYS AS (json_extract(record, '$.client_ip')) STORED,
  client_hostname GENERATED ALWAYS AS (json_extract(record, '$.client_hostname')) STORED
);
CREATE INDEX requests_ts ON requests(ts);
CREATE INDEX requests_model_ts ON requests(model, ts);
CREATE TABLE gpu_samples (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, sample TEXT NOT NULL,
  "index" GENERATED ALWAYS AS (json_extract(sample, '$.index')) STORED,
  memory_used_mib GENERATED ALWAYS AS (json_extract(sample, '$.memory_used_mib')) STORED,
  memory_total_mib GENERATED ALWAYS AS (json_extract(sample, '$.memory_total_mib')) STORED,
  utilization_percent GENERATED ALWAYS AS (json_extract(sample, '$.utilization_percent')) STORED,
  temperature_c GENERATED ALWAYS AS (json_extract(sample, '$.temperature_c')) STORED,
  power_w GENERATED ALWAYS AS (json_extract(sample, '$.power_w')) STORED
);
CREATE INDEX gpu_ts ON gpu_samples(ts);
```

`record` is canonical RequestRecord JSON. Its embedded ID is assigned on reads
from the SQL ID. `ts` is already UTC milliseconds, but its name/type is not
enforced. Durations in this JSON are Ollama nanoseconds; `latency_ms` is REAL
wall time. GPU JSON contains its own `ts`; SQL stores a second timestamp.
Generated columns have no declared types or NOT NULL constraints. JSON validity
is indirectly required by extraction, not an explicit schema contract.
GPU deletion happens at open and every sample cycle, including failed telemetry
cycles; request deletion does not happen. One unbounded FIFO serves reads and
writes on a dedicated thread. Reads preserve queued-write visibility but can
delay writes. A write error poisons subsequent database queries until restart.

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
Cache rows are mutable upserts. Every sync/usage open reruns IF NOT EXISTS DDL.
SQLite and pricing work run in `spawn_blocking`, not on Tokio workers, but
connections are opened per operation rather than pooled.

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
then OpenRouter, then later rowid. Pricing CLI and factory-api both open stores
with WAL and five-second busy timeouts; API's extra history connection bypasses
these settings. No connection explicitly sets foreign keys, synchronous,
journal-size limits or maintenance policy. Defaults must not be mistaken for
verified live settings.

### Discrepancies, not schema drift

- The root README's opening still says factory-api is not built, and its Future
  section and pricing README describe integration as future work. Code implements it.
- Root README says usage includes all meter rows; current `data::usage` filters
  to six inference endpoints. The cache/meter still store all rows. This audit
  preserves current inference-only API totals and all-endpoint meter stats.
- Root README describes only newest-first requests; meter now also supports
  `after_id` ascending pages, max 5,000, with `next_after_id`. API sync has not adopted it.
- API outward timestamps are milliseconds, but pricing storage/API internals
  remain seconds and money remains floating point. Conversion at HTTP boundaries
  does not satisfy database standards.

## Query inventory and measured plans

Counts below are **source-derived application data statements**, not measured
production traffic or instrumented endpoint counts. SQL IDs identify the exact
queries and parameters in Appendix A's reproducible command. Every current data
statement, including writes and scalar subqueries, is covered. Scalar subqueries
belong to one statement, not another round trip. DDL, PRAGMAs and BEGIN/COMMIT
are cataloged separately because they have no useful data-access EQP.

Fixture: 365,000 requests spread across 365 days, 20 model slots (including NULL),
50 clients, missing tokens/errors/non-inference controls; 40,320 GPU samples at
15 seconds over seven days; 365 refreshes, 1,000 models × two sources per refresh
(730,000 prices), 1,460 selections, 3,650 pricing items, 10 cache warnings.
Counts and integrity checks succeeded. This is a plausible capacity fixture,
**not an observed production distribution**. Daily confirmed rows intentionally
stress selection history; real confirmations need not be that frequent.
EQP ran after ANALYZE on Python SQLite **3.46.1**, then all 30 cases were replayed
against the workspace's compiled bundled SQLite **3.51.1**: every plan matched.
Appendix B records that read-only replay. These are not measured timings or
proof of the reported MET-90 latency's entire cause.

### Meter endpoints and jobs

| Caller/frequency | SQL ID and operation | Count | Observed EQP / risk |
| --- | --- | --- | --- |
| `/meter/health`, on demand; shutdown barrier once | M1: SELECT id,record LIMIT 0 | 1 | SCAN requests in EQP; LIMIT 0 reads no data. Explicit exception, not an expensive scan |
| `/meter/requests`, on demand; API polls every 30s | M2: newest ORDER BY id DESC LIMIT N | 1 | SCAN requests; bounded reverse rowid walk, not all-history traversal; max N=10,000 |
| `/meter/requests?after_id`, on demand | M3: id > cursor ORDER BY id ASC LIMIT N | 1/page | SEARCH INTEGER PRIMARY KEY (rowid>?); max N=5,000; no N+1 |
| `/meter/stats`, on demand, 24h/7d/30d | M4: ts >= cutoff; M5 adds model equality | 1 | SEARCH requests_ts or requests_model_ts; deserializes all matches, sorts latencies in Rust |
| `/meter/gpu/history`, on demand, 24h/7d/30d | M6: ts >= cutoff ORDER BY ts,id | 1 | SEARCH gpu_ts, no temp sort; returns all retained matches |
| `/meter/gpu`, `/meter/openapi.json` | No SQLite query | 0 | Live GPU subprocess/upstream HTTP, or generated contract |
| Proxy completion/disconnect/upstream failure | W1: INSERT requests(record) | 1/request | Direct VALUES; no EQP rows; not an N+1 read |
| GPU sampling, immediately then every configured interval (default 15s) | W2: INSERT gpu_samples(ts,sample); M7: DELETE ts < cutoff | G+1/cycle | G GPU inserts, then indexed DELETE, including G=0; currently not one transaction |
| Startup | IF NOT EXISTS tables/indexes plus M7 | 1 DELETE | On existing schema SEARCH gpu_ts; first empty DB can scan before index creation |
| Host refresh, immediately then every 300s | No SQLite query | 0 | Tailscale subprocess/in-memory map |

M4/M5 were explained at 24h; their predicates/indexes also serve 7d/30d, but
those wider meter plan variants were not separately measured in this audit.

### Factory-api endpoints and collectors

Let F be reference families (currently 2), R inference requests in range,
T requests with both token counts, n rows fetched (0–500 currently), and g=1
if a new gap warning is inserted, otherwise 0. Let V be the cost of `pricing_view`:
P13 once plus P1/P2 once per family and P3 for each selected/pending model;
**V ≤ 1+4F** (9 today).

| Caller/frequency | Statements | Current count and risk |
| --- | --- | --- |
| GET `/v1/llm/usage`, on demand | C5 range records, C6 warnings; pricing show P1/P2/P3; C4 earliest rate per family; P1 then optional P3 per complete-token request/family | ≤ 2+5F+2TF, bounded by 2+5F+2RF. At F=2, R=T=30,000: up to **120,012** statements, before setup. Main N+1 |
| GET `/v1/pricing`, on demand | P13, P1/P2/P3 via pricing_view | V ≤ 9 today; repeated per family, bounded config but should batch |
| POST `/v1/pricing/refresh`, and startup/daily collector | pricing_view before/after, then pricing refresh job below | 2V + refresh job. Network fetches have independent 60s timeouts and are not SQL latency |
| POST `/v1/pricing/confirm/{family}`, on demand | Dispatcher pricing_view, method before/after pricing_view; P2, P11, P12 | Success 3V+3 ≤ 30 today; unknown/no-pending returns after V. Transactions add BEGIN/COMMIT |
| Meter collector, immediately then every 30s | C1 MAX(id); C2 gap warning conditional; C3 upsert per fetched row | 1+n+g, plus BEGIN/COMMIT; repeated upserts of old rows, at most 502 data statements |
| GET `/v1/gpu`, on demand | Meter `/meter/gpu` and M6 upstream | 0 local, 1 remote SQL; 1h downloads 24h then filters GPU 0/time in Rust |
| GPU collector, immediately then every 15s | Meter live GPU | 0 local/remote SQLite queries |
| GET `/v1/fleet`, startup/every 30s fleet collector | TOML, Tailscale, HTTP/TCP/systemd checks | 0; initial GET can collect if fleet not initialized |
| `/v1/health`, `/v1/agents`, `/v1/stream`, `/openapi.json`, kiosk/static handlers | In-memory/API/static | 0; SSE subscription itself never queries history |
| Startup AppState::new | Opens cache and pricing, creates IF NOT EXISTS schema | Setup only; no persisted fleet tables |

| Cache/history SQL | Observed plan | Interpretation |
| --- | --- | --- |
| C1 `SELECT COALESCE(MAX(id),0) FROM requests` | SEARCH requests | Rowid endpoint lookup; loses independent cursor state when retention removes rows |
| C2 `INSERT OR IGNORE INTO warnings VALUES (?1)` | No EQP rows | Unique TEXT key deduplication |
| C3 request INSERT with ON CONFLICT(id) UPDATE ts_ms,record | No EQP rows | PK conflict lookup, not a read N+1; per-row writes need batching |
| C4 earliest rate, nested earliest confirmed model selection | SEARCH snapshot_lookup/model; SEARCH selection_lookup/family; TEMP B-TREE FOR LAST 3 TERMS OF ORDER BY | One query/family, not request; preserves earliest-observed fallback; tie sort remains |
| C5 `SELECT record ... WHERE ts_ms>=?1 ORDER BY id` | **SCAN requests** at 24h, 7d and 30d | Timestamp index loses to requested rowid order on analyzed fixture; every range scans history |
| C6 `SELECT message FROM warnings ORDER BY message` | SCAN warnings USING COVERING INDEX sqlite_autoindex_warnings_1 | Intentional whole small warning set; currently grows indefinitely |

Ordering C5 by ID is not needed for usage aggregates. Remove that ordering when
changing its owner, rather than adding an index that cannot cheaply satisfy both
an arbitrary time range and rowid order. Plan tests must confirm time-index use.

### Pricing library/CLI jobs (also called by factory-api)

| SQL ID / exact operation | Frequency within caller | Observed plan / N+1 risk |
| --- | --- | --- |
| P1 selected: family, confirmed=1, effective_from<=at; ORDER BY effective_from DESC,rowid DESC LIMIT 1 | `show`: F; `cost`: 1; `refresh`: F | SEARCH selection_lookup (family/effective_from); confirmed is post-filter, tie identity is implicit |
| P2 pending: latest refresh; later rowid than last confirmation; ORDER BY effective_from DESC,rowid DESC LIMIT 1 | `show`: F; `confirm`: 1 | SEARCH rowid>?; scalar SEARCH reference_selection and refreshes; TEMP B-TREE ORDER BY; family/confirmed are post-filters |
| P3 rates: model_id, fetched_at<=at; ORDER BY fetched_at DESC,refresh_id DESC,(source='openrouter') DESC,rowid DESC LIMIT 1 | `show`: 0–2F; `cost`: 0–1 | SEARCH snapshot_lookup plus TEMP B-TREE FOR LAST 3 TERMS; per-cost invocation amplifies round trips |
| P4 / P11 MAX(effective_from) over selections | Refresh once / confirm once | SEARCH COVERING selection_lookup; leading family prevents a global effective-time endpoint seek; EQP's SEARCH is not proof of constant work |
| P5 MAX(fetched_at) over refreshes | Refresh once | SEARCH refreshes, but no fetched_at index: aggregate visits history |
| P6 MAX(released_at) WHERE model_id=? | **Every secondary model**, S times/refresh | SEARCH snapshot_lookup/model; visits model history; `.or(query_row(...)?)` is eager even if current primary supplied date. Second N+1 |
| P7 INSERT refreshes | Refresh once | Direct VALUES |
| P8 INSERT snapshots | Refresh M times, M=primary+secondary | Direct VALUES; necessary writes, can batch |
| P9 INSERT unconfirmed selection | Refresh B times, B≤F | Direct VALUES |
| P10 INSERT pricing item | Refresh I times | Direct VALUES |
| P12 INSERT confirmed selection with MAX(rowid) refresh subquery | Confirm once | SCALAR SUBQUERY, SEARCH refreshes |
| P13 latest-refresh items ORDER BY rowid | `items`: once; each pricing_view once | **SCAN pricing_items**, scalar SEARCH refreshes; missing refresh_id index |

`refresh` data count = 2+S+F+1+M+B+I (plus one immediate BEGIN/COMMIT).
`confirm` = 3 data statements (plus immediate BEGIN/COMMIT).
`cost` = 1–2 reads; CLI issues it once, usage issues it T×F times.
CLI `show` = V; CLI refresh/confirm have no before/after views. CLI calls are
operator-driven, not scheduled in pricing itself. Failed both-source refresh
has no refresh data statements; failed validation can roll back partial writes.

### Connection setup and non-query jobs

Meter open runs `journal_mode=WAL`, `busy_timeout=5000`, two table creations,
three index creations and the GPU DELETE; all reads share that connection.
Cache open on sync/usage repeats two PRAGMAs, two table and one index creation.
Pricing Store open uses busy_timeout and WAL, four table and two index creations.
`usage` additionally opens one unconfigured pricing history connection.
No application `PRAGMA user_version`, migration history, explicit optimize,
checkpoint job, or request-rollup/retention job exists. Maintenance/setup
statements must be counted separately in future tests so they cannot hide inside
a per-row connection open. SQLite's internal statements are not application queries.

MET-74 snapshots use SQLite `.backup`, then `PRAGMA integrity_check` per database.
Restore checks enumerate tables and SELECT COUNT(*) for each. These deliberate
offline full scans are not hot endpoint queries. Backup runs daily at 03:15 GPU /
03:45 console host-local time plus jitter; installer/manual calls also exist.
This audit did not run those scripts or access their production databases.

## Findings ranked by impact

1. **High (audit snapshot): request-scale pricing reads and cache full scans.** Indexed individual
   lookups do not rescue 120,012 statements per 30k-row usage response. C5 also
   scans all cache rows for every supported range. Freeze/batch historical costs,
   remove unnecessary ordering, then serve rollup aggregates. This supports
   MET-90's diagnosis but does not independently reproduce its live timeout. PR
   #15 since removed the usage pricing N+1 and added a factory-api pool and indexes;
   step 3 re-baselines this budget against current main.
2. **High: sync loses historical coverage and cannot backfill.** Newest 500 per 30s means
   more than 500 arrivals between successful polls (about 16.7/s sustained), or
   an outage with more than 500 rows, produces gaps. Current `factory-api` code
   does request `after_id` pages with `next_after_id`, but initializes that cursor
   from `MAX(id)` on each sync rather than persisting separate sync state. A fresh
   cache cannot backfill old history; existing gap warnings report loss but do not
   recover it. Persist a separate cursor before pruning; expose missing history,
   and do not equate ID gaps with zero usage.
3. **High: migration/retention can break IDs and financial reproducibility.**
   Current ordinary INTEGER PRIMARY KEY may reuse IDs after deletion; MAX(id)
   as cache watermark can regress if emptied. Prices use REAL, seconds, implicit
   rowids and no FK. Preserve identities and tie order, snapshot first, convert
   money explicitly, store per-request per-family classifications/costs.
4. **Medium: refresh and latest pricing views deteriorate with history.** Eager
   P6 performs S historical lookups; P13 scans items. Rate tie sorting and
   non-leading aggregate indexes leave avoidable work. Batch history and index
   exact predicates/order, not just the first WHERE column.
5. **Medium: storage/read contention lacks bounded lifecycle.** Unbounded meter
   queue, JSON duplication, raw requests and warnings grow indefinitely. Reads
   on writer FIFO can stall ingestion. Per-call connections and runtime DDL
   bypass a standard policy. Dedicated writer/readers, bounded work, rollups,
   retention and WAL monitoring address different problems; a pool alone is
   not a durability fix.
6. **Medium: attribution and aggregation semantics are not enforced.** No user
   identity/actor columns; NULL tokens must remain unknown. Daily p95 cannot be
   averaged from hourly p95. Costs must not combine alternative reference
   families. These invariants need regression tests, not documentation alone.

## Target schema contract

The definitions below are the implementation contract, not executable migrations
in this PR. Every application table ends in STRICT, with explicit column types,
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

API `sync_state`: `id INTEGER PRIMARY KEY CHECK(id=1)`, `last_after_id INTEGER NOT
NULL CHECK(last_after_id>=0)`, `synced_at_ms INTEGER NOT NULL CHECK(synced_at_ms>=0)`.
STRICT singleton, initialized from existing MAX(id), not recalculated after
pruning. Commit cache rows and cursor in one transaction; emit SSE only afterward.
Use ascending cursor pages and a bounded catch-up loop. Numeric ID discontinuities
are diagnostic, not conclusive proof of lost committed rows after AUTOINCREMENT;
meter must expose its oldest retained ID for retention-loss detection. A restored
meter whose maximum ID is below the API cursor requires explicit reconciliation,
not automatic cursor advancement or silently treating it as an empty page.
Before costs/rollups activate, backfill missing retained history using cursor
pages starting at the relevant earlier IDs; the migrated MAX(id) checkpoint alone
does not recover old gaps. After activation, reject a newly discovered lower ID
at or below the rollup checkpoint from normal sync and require explicit aggregate
reconciliation. Higher-ID late timestamps are handled by the normal job. Do not
silently insert lower-ID backfill that an ID checkpoint would never aggregate.

API `warnings`: `message TEXT PRIMARY KEY`, `first_seen_ms INTEGER NOT NULL`,
`last_seen_ms INTEGER NOT NULL`, `resolved_at_ms INTEGER`; all nonnegative UTC times,
STRICT. Existing gap strings get migration time for first/last observation and
NULL resolution; don't invent past dates. Index `(resolved_at_ms,last_seen_ms)`.
Unresolved coverage gaps stay visible; resolve only after verified backfill or
operator acknowledgement, never automatically on a successful new poll.

### Pricing: migrate early, preserve all history

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

Copy **each old rowid to its table's explicit ID**. Preserve refresh_id values,
including same-second refreshes, so ordering and pending withdrawal do not change.
Do not deduplicate historical rows or add uniqueness not present in the old
contract. Foreign keys are database-local; model IDs are external feed identifiers.
Batch `show`/history reads through pricing's public library instead of letting
factory-api duplicate private SQL. Earliest fallback needs its own correctly
indexed ascending order variant if the descending lookup index leaves a sort;
verify its complete order with the bundled EQP helper before choosing that index.

Money rules:

- Legacy REAL USD/Mtok becomes nearest integer micro-USD/Mtok, nonnegative ties
  rounded half-up. First validate finite/nonnegative values and checked range;
  record every changed rate and the rounding delta in the migration report.
  Legacy floating-point input cannot recover an original exact decimal; report
  that limit. New feed parsing uses decimal strings/JSON numeric lexemes with
  checked integer decimal scaling, never an intermediate f64 money value.
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
| meter + API `requests` | 365 days raw | `ts_ms < now_ms - 365*86400000`, only IDs included in committed rollups |
| API `request_costs` | Same 365 days as parent | Cascade only after spend rollups include every family classification |
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

## Shared DB crate design and adoption

Create one workspace crate, provisionally `factory-db`, depending on the existing
rusqlite version/features. `shared` stays the wire-contract crate. Keep schema
and business queries in their owners, not in a universal repository abstraction.

- **Pool/execution:** one writer plus initially two readers per file DB, each
  owned by a dedicated blocking OS thread. Bound submitted operations (initial
  capacity 1,024); overload never slows inference: meter drops rows, counts drops,
  and surfaces a warning and MET-76 alert rather than unbounded growth or a blocked
  Tokio worker. Async callers await results; pricing CLI can
  use a synchronous facade to the same queue. No fresh connection per endpoint.
  Reader transactions are short-lived and query-only. Meter read-after-write
  calls use an acknowledged writer barrier **before** opening the read snapshot.
  Preserve shutdown drain/write-error semantics.
- **Settings:** writer startup sets/verifies `journal_mode=WAL`; every connection
  sets `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`,
  `journal_size_limit=67108864` (64 MiB); readers also `query_only=ON` after setup.
  MEMORY journal is an explicit in-memory-test exception, never a file fallback.
  NORMAL preserves consistency but may lose latest commits on power loss; MET-104's
  UPS covers power outages. Journal size limit does not cap an active WAL held by
  long readers. Configure autocheckpoint (1,000 pages),
  attempt PASSIVE checkpoint every five minutes, observe busy/WAL size; TRUNCATE
  only in a reader-free maintenance window. Optimize on startup after migration
  and daily; verify resulting settings on all pool connections in tests.
- **Migration runner:** owner supplies ordered immutable SQL/Rust migrations;
  runner owns `PRAGMA user_version`, startup exclusive ownership, transaction,
  pre/post checks, version rejection and reporting. No DDL from request handlers.
  Before a new schema version, migrations run on writer before readers/listener
  start. Unknown/newer versions fail without writes. Legacy version adoption
  verifies exact schema fingerprint; it never assumes IF NOT EXISTS upgraded it.
  Check foreign keys before commit and integrity/counts after. Retain a migration
  checksum manifest in the binary/tests; do not add an unnecessary history table.
- **Counter:** count every executed application statement on every writer/reader,
  with a request/job scope ID propagated across threads and both API databases.
  Prepared statement executions count; scalar subqueries do not count twice.
  BEGIN/COMMIT, setup/migration and maintenance are separate named budgets, not
  ignored. Do not rely on a SELECT-only counter or thread-local scope that is
  lost in `spawn_blocking`. Reset isolated scopes, never a shared global counter
  while concurrent operations are running. Runtime query-counter metrics wait for
  MET-76; until then, tests enforce budgets.
- **EQP helper:** run parameter-bound EXPLAIN QUERY PLAN with bundled SQLite on
  realistic fixture sizes/selectivities and ANALYZE. Match semantic plan features
  (required search/index, forbidden unrestricted hot-table scan/temp sort), not
  unstable node IDs or exact entire plan text. Cover cutoff selectivity, ties,
  NULL dimensions and common filters. Explicit reviewed exceptions are LIMIT 0,
  bounded newest-ID walks, small complete config/warning reads and offline
  migration scans. SEARCH alone is insufficient for global MAX on wrong leading
  indexes; add bounded-work benchmarks/row-visit diagnostics for those paths.

Data-statement budgets: API ceilings below are enforced by `cargo test --workspace`.
Other owners' budgets remain targets until adoption. Transaction, setup and
maintenance statements are counted separately, never hidden in data ceilings.

| Endpoint/job | Budget, independent of request history unless stated |
| --- | --- |
| meter health / requests / stats / GPU history | 1 / 1 per page / ≤4 with rollups+raw quantile / ≤2 with raw+hourly history |
| API health/fleet/agents/SSE/static/OpenAPI and GPU collector | Measured ceiling **0** local DB statements; target after step 5: **0** |
| API GPU | Measured ceiling **0** local; target after step 5: **0 local, ≤2 upstream history** (upstream enforcement awaits meter adoption) |
| API usage | Measured ceiling **16** total reads for 24h/7d/30d with two selected and pending families; target after step 5: **≤8**, regardless of R |
| API pricing / confirm | Measured ceilings **9 / 29** across all views and confirmation, including HTTP confirmation preflight; target after step 5: **≤3 / ≤12** |
| API pricing refresh | **No refresh budget test yet**: owner refresh N+1 (audit P6) is step-4 debt. Target after step 5: **≤6 view reads** plus the pricing-refresh job budget below |
| API meter-sync page | Measured job ceiling **1 + ceil(n/100) + ceil(g/100)**, g gap warnings, plus **1 cursor read per sync run**; both inserts batch 100 rows, no per-row SELECT. Target after step 5: **≤10 + 2*ceil(n/100)** including pricing history and separate raw/cost batches; n≤5,000 (current wire pages ≤500) |
| Pricing refresh | **Unenforced until step 4 (P6)**. Target: ≤6 + ceil(M/100) + ceil(B/100) + ceil(I/100), with bulk release history; no S per-model reads; M is source rows, B pending rows, I items |
| Rollup/retention | ≤16 per ≤5,000-row batch per database; pruning chunk ≤5,000; cost families fixed by input configuration |
| GPU sampling | G+1 data statements, plus one transaction; G physical GPUs |

API budget fixtures exercise 3 and 1,001 successful request rows, two pricing
families with asymmetric history, NULL/non-NULL model groups, and both selected
and pending rates. Usage costs/tokens and confirmation outcomes are asserted.
All-gap sync fixtures measure 4 and 26 statements respectively (page jobs 3 and
11/11/3, plus the initial cursor read). The inherited single-selected-family
case remains 13 reads for 1 and 1,000 rows; it is not the worst successful view.
Usage/pricing/HTTP confirm additionally count 4/2/8 transaction statements.
Fresh API startup counts 72 requests-DB and 80 pricing-DB setup statements across
all six connections, plus one startup optimize per writer. Tests reject setup or
maintenance statements inside request scopes. Runtime metrics remain MET-76.

Each budget must be exercised with small and large **successful** workloads,
not only empty/error branches. Endpoints with multiple family views must use
batch queries, not inflate budgets to allow request-scale reads. Tests for sync
and refresh use deliberately asymmetric row counts and at least two families.
Budget constants live next to owning endpoint/job tests; any increase needs a
reviewed doc change. Setup has its own per-pool-start budget; zero setup statements
are allowed inside a row loop.

Step 3 adoption: **factory-api uses `factory-db` pool, settings, scoped statement
counter and EXPLAIN helper, not migrations**. Each file has one writer plus two
readers on dedicated OS threads (six total), with 1,024 outstanding jobs per file,
explicit overload, cancelled-job skipping, persistent 64 MiB reader caches and
short query-only snapshots. Usage materializes cache rows before opening its
pricing snapshot; neither this nor the prior implementation promises an atomic
snapshot across independent files. The shared writer barrier provides FIFO
read-after-write when needed. Shutdown closes admission, drains accepted live
jobs, then closes connections. PASSIVE checkpoints run every five minutes and
optimize runs at startup and daily, outside requests. No TRUNCATE or VACUUM.

The rusqlite 0.38 trace/profile APIs accept function pointers, while progress
counts VM instructions. The counter uses exported SQLite `trace_v2` with an owned
per-connection context and explicit scope handles, including across both files;
no global reset or thread-local scope. Existing bundled/trace features suffice.
EXPLAIN tests replay traced SQL templates with bound values on analyzed fixtures.
Exceptions explicitly retain complete warning reads and legacy pricing sorts
for refresh/source/rowid ties; pricing's step-4 indexes must remove those sorts.

Transitional debt: startup's existing `IF NOT EXISTS` DDL is unchanged, not a
migration; API cache adopts the runner in numbered migration 3. Pricing adopts
shared infrastructure and migrations in step 4; meter adopts in its later typed
schema step, preserving FIFO visibility. Pricing's narrow connection constructor/
accessor integration removes its 1,000 ms timeout override so the API can apply
5,000 ms; the standalone pricing CLI remains unadopted. **Audit P6 refresh N+1**
(one release-history SELECT per secondary model, plus per-row writes) remains
known step-4 debt, with no refresh budget test in this PR. No schema/unit/pricing
behavior changes or production migrations occur in step 3. The runner ships
tested only on disposable sample schemas. Costs, rollups and retention follow.
Enforcement is `cargo test --workspace`; this PR adds no CI workflow. These
explicit legacy debts are not permission to introduce new per-row SQL.

## Ordered migrations and rollback

No production migration is authorized by this documentation PR. Installers in
later PRs must require a **fresh MET-74 snapshot before every numbered migration**,
not merely rely on yesterday's backup. Coordinate application stop/quiesce and
backup lock/timer; keep Ollama running. Use SQLite backup API including WAL,
checksum/compress/integrity verification, and record archive path, code version,
schema version and per-table row counts. Restore/decompress into a scratch DB
first. Enough space for old DB, new tables/indexes, WAL and snapshot is a hard
preflight gate. MET-74 is installed and restore-checked on both nodes (2026-10-11).

Current schemas are legacy version 0 **only after validating schema and actual
user_version**. Proposed versions are per DB, not one shared global version:

| Order / DB migration | Work and verification | Reversibility |
| --- | --- | --- |
| 1. pricing v1: explicit IDs + STRICT + ms/money | Copy refreshes first; then snapshots/selections/items; old rowid→id, seconds×1000 with overflow validation, REAL rates→integer with rounding report; add FKs/order indexes; count every table, compare all IDs/FKs and selection/rate tie results; advance version only on success | **Backup-gated**; rounded REAL money cannot be losslessly down-migrated |
| 2. meter v1: typed facts + attribution | Rebuild requests/GPU, extract/validate all JSON values, preserve IDs and ns durations, rename ts to ts_ms, initialize users, indexes/AUTOINCREMENT sequence above historical maximum; no retention yet; count both tables, compare token sums/null counts/ranges and wire output | **Backup-gated**; normalized JSON/wire reconstruction must not rely on an untested reverse transform |
| 3. API cache v1: typed replica + durable cursor/warnings | Rebuild requests under same fact contract; move MAX(id) into sync_state before any deletion; add dated warning metadata; count requests/warnings and validate IDs/JSON timestamp equality; adopt cursor sync, reconcile known gaps from retained meter pages | **Backup-gated**; preserve original warning text and checkpoint; restore with compatible binary |
| 4. API cache v2: frozen costs | Add request_costs, backfill in resumable id batches against pricing v1; no pruning. Count = inference rows × configured families; prove each classification, integer totals, zero vs NULL and selected/snapshot provenance. Publish backfill-complete state only after all rows pass | Schema addition can be reversed by dropping costs/reverting compatible code **before any rollup/pruning**; snapshot still mandatory |
| 5. meter v2 and API cache v3: rollup tables/state | Add hourly/daily metrics, API spend, GPU hourly and state; build retained history in bounded resumable batches; compare aggregate counts/tokens/costs against raw before enabling reads. Existing missing history is not reconstructed | Additive and reversible by dropping new tables/reverting code **before pruning**; snapshot mandatory |
| 6. scheduled jobs activated after all backfills | Enable five-minute jobs, then enable 365-day request / seven-day GPU pruning only after checkpoints and comparison gates; count every table before/after each prune and match deleted counts to eligible IDs | **Backup-gated** once rows are deleted; migration runner's version alone must not enable irreversible deletion |

For all table rebuilds, use new temporary-named tables with **explicit column
lists**, copy in a migration transaction, validate before dropping/renaming,
recreate indexes, run FK checks, then commit and set user_version atomically.
No silent CAST of invalid JSON/types/overflow or dropped "bad rows". Fail with
offending IDs; the operator repairs a copy or chooses a separate explicit policy.
Check cache SQL ts_ms equals JSON ts and ID equals JSON id; check GPU SQL ts
equals sample ts if supplied. Preserve NULL token semantics. Counts alone are
necessary but not sufficient; also compare primary keys, sums, time bounds,
tie cases and representative serialized records. Row counts for additive tables
are expected formulas/checkpoints, not equality with nonexistent old tables.

Pricing/API are one console service; stop it for pricing conversion, stage a
compatible library/API/CLI binary together, migrate pricing, verify and restart
only after cache compatibility is checked. Meter v1 keeps legacy wire field
names `ts` and nanosecond duration names while adding optional attribution with
serde defaults, so console migration need not coincide with meter downtime.
Versioned internal names must not accidentally break older clients. No migration
implicitly confirms a model, refreshes a feed, rewrites attribution, or changes
the inference allowlist.

### Rollback procedure for every backup-gated step

1. Stop the affected application and backup timer/service; never stop Ollama.
   Keep writes stopped until restoration and health checks finish. Stop API sync
   too when rolling meter back, to avoid stale cache/cursor mixing.
2. Verify the selected pre-step archive checksum, decompress into a temporary
   same-filesystem directory, run integrity/FK checks and compare stored counts.
3. Move current DB **and WAL/SHM together** to a timestamped recovery directory.
   Install the verified snapshot, correct service ownership/mode (0600), restore
   the compatible pre-migration binary. Never replay a newer WAL on the restore.
4. For console multi-DB steps restore the paired requests/pricing snapshots
   while API stays stopped; do not mix old cache costs with rewritten pricing IDs.
   For meter restore reconcile API's cursor/cache against restored meter IDs;
   either restore an aligned API snapshot or explicitly rebuild the synced copy.
   Do not automatically erase coverage warnings.
5. Restart application, check health, cursor/usage/pricing historical fixtures
   and version, then restart backup timer. Keep failed/new files for diagnosis;
   if any check fails, remain stopped. Re-run counts and record restoration result.

Restoring a snapshot loses writes after its timestamp; quiescing before a fresh
snapshot makes the migration window loss explicit. A failed transactional rebuild
rolls back in place and leaves old user_version; still verify before reopening.
After completed pruning, schema rollback alone cannot recover deleted raw rows.
Rollup retention intentionally cannot recover seven-day-expired GPU details or
365-day-expired individual requests without an older backup that still contains them.

### Implementation test matrix (required in later PRs)

- **Empty DB:** run each owner's complete version sequence, assert STRICT tables,
  explicit schema/index/FKs, PRAGMAs on every connection, final version; run again
  unchanged. Perform real endpoint/job reads/writes through public APIs.
- **Production-schema fixture:** commit DDL-only fixtures copied from these three
  captures with hashes/provenance; fill deterministic synthetic rows with same-ms
  refresh ties, withdrawn pending, both price sources, zero/null tokens, Unicode
  model/user names, fractional rates, exact cost-rounding ties and pre-history
  requests. Migrate every intermediate version and compare public outputs to
  independently computed expected results, including legacy wire compatibility.
- **Failure/rollback:** invalid JSON, SQL/JSON timestamp mismatch, orphan refresh,
  negative/nonfinite/out-of-range rates and timestamp multiplication overflow
  fail without partial schema/version changes. Interrupt mid-copy/backfill, test
  transaction rollback/idempotent resume, restore verified MET-74-format snapshots
  into disposable DBs and rerun public queries. Corrupt/missing snapshots fail
  before replacement. Test old/new version rejection and wrong schema fingerprint.
- **IDs/sync:** empty-after-retention meter cannot reuse an earlier request ID;
  cache restart preserves cursor when cache is empty. Multiple cursor pages,
  retry/upsert, >500 arrivals and API outages produce no duplicates; lost retained
  history/restored-source mismatch surfaces coverage warnings. Cost backfill
  does not advance a sync checkpoint without committed raw/cost rows.
- **Rollups:** compare raw and hourly/daily sums over asymmetric UTC boundary
  windows, DST dates, NULL identities, two real users, humans/agents, unknown
  counts and two families. Validate mean-of-ratios (not ratio-of-sums), zero vs
  unpriced, late rows, crash before/after checkpoint, no duplicate contribution,
  no hourly/daily edge overlap, exact current-range percentiles from raw, and
  flagged approximate older-range percentiles from merged fixed-bucket histograms.
  Verify only retained unpriced rows can become estimated and that each fill-in
  rewrites affected spend buckets in its transaction. Rates changing after ingest
  cannot alter frozen costs. Pruning at cutoff-1/cutoff/
  cutoff+1 proves the strict boundary and prevents deletion when rollups lag.
- **Enforcement:** realistic analyzed fixtures run hot-query EQP checks under
  bundled SQLite; query budgets compare small/large successful requests and
  collectors with concurrent scopes and both databases. Failure branches don't
  conceal N+1. Test bounded queue overload and writer-barrier visibility; long
  readers/WAL maintenance must not block Tokio workers or claim nonexistent WAL caps.

## Decided (2026-10-11)

- Rates remain INTEGER micro-dollars per Mtok; request costs and totals are i64
  nano-dollars, rounded half-up once per request with checked i128 arithmetic.
  Priced/estimated rows are frozen; retained unpriced rows alone may become
  estimated through the transactional fill-in job. Other rewrites need a
  versioned restatement design.
- Raw rows provide exact nearest-rank percentiles for the 365-day window. Hourly
  fixed-bucket latency histograms merge into daily histograms; older ranges are
  approximate and flagged. Buckets/storage are fixed, versioned and additive.
- WAL plus `synchronous=NORMAL` is accepted. MET-104's UPS covers power outages.
  Meter's bounded 1,024 write queue drops on overflow without slowing inference,
  counts drops, and surfaces a warning and MET-76 alert. Runtime query-counter
  metrics wait for MET-76; tests enforce budgets until then.
- MET-74 is operational on both nodes with restore-checked nightly timers. Each
  migration still requires a fresh snapshot.

Not verified at audit time: live counts/data/PRAGMAs/user_version, production performance,
backup installation/restore permissions, deployment, or any proposed
migration/rollup implementation. Capture timestamps alone do
not prove current live schema remains unchanged. No production DB was opened,
no feed was refreshed, and no service/deployment script was run.

## Appendix A: executed audit commands and reproduction

Run from repository root on factory-gpu. Only scratch fixtures are writable.
The discovery commands were `find`/`grep` because `rg` is unavailable:

```sh
find meter factory-api pricing shared docs -type f -not -path '*/target/*'
grep -RInE '(SELECT |INSERT |UPDATE |DELETE |CREATE TABLE|Connection::|execute_batch)' \
  meter/src factory-api/src pricing/src --include='*.rs'
sha256sum /tmp/live-schemas/*.sql
python3 -c 'import sqlite3; print(sqlite3.sqlite_version)'
```

The following is the complete executed scratch program. Save it as
`.amp/in/audit.py`, after adding `/.amp/in/` to `git rev-parse --git-path
info/exclude` and creating `.amp/in/artifacts/`. It refuses to overwrite any
fixture. Its literal-SQL extraction is pinned to the audited source: C/P numbers
follow source order; future source changes require reviewing the inventory.
Source contains no escaped SQL literals among those extracted. Meter's dynamic
queries substitute representative cutoffs/cursors. EXPLAIN prepares but does
not execute writes. Fixture INSERTs and ANALYZE operate on scratch DBs only.

```python
import hashlib
import json
from pathlib import Path
import re
import sqlite3

ROOT = Path.cwd()
OUT = ROOT / '.amp/in/artifacts'
OUT.mkdir(parents=True, exist_ok=True)
NOW = 1791720000000
DAY = 86400000
dbs = {}
for name, schema in [('meter', 'factory-gpu-meter'), ('cache', 'factory-console-requests'), ('pricing', 'factory-console-pricing')]:
    path = OUT / (name + '.db')
    if path.exists():
        raise RuntimeError(f'Remove only the disposable fixture before rerunning: {path}')
    ddl = Path('/tmp/live-schemas/' + schema + '.sql').read_bytes()
    print(name, 'schema SHA256', hashlib.sha256(ddl).hexdigest())
    db = sqlite3.connect(path)
    db.executescript(ddl.decode())
    dbs[name] = db

def records():
    for i in range(365000):
        ts = NOW - 365 * DAY + i * DAY // 1000
        yield i + 1, ts, json.dumps(dict(ts=ts, endpoint='/api/chat' if i % 10 else '/api/ps',
            model=f'model-{i % 20}' if i % 10 else None, prompt_eval_count=100 + i % 97,
            eval_count=None if i % 17 == 0 else 20 + i % 31, load_duration=2000000,
            prompt_eval_duration=100000000, eval_duration=200000000,
            total_duration=302000000, usage=None, latency_ms=302.5,
            status=500 if i % 53 == 0 else 200, stream=True, error=None,
            client_ip=f'100.64.0.{i % 50}', client_hostname=f'host-{i % 50}'))
dbs['meter'].executemany('INSERT INTO requests(id,record) VALUES (?,?)', ((i, r) for i, t, r in records()))
dbs['cache'].executemany('INSERT INTO requests VALUES (?,?,?)', records())
dbs['cache'].executemany('INSERT INTO warnings VALUES (?)', ((f'gap: {i}',) for i in range(10)))
dbs['meter'].executemany('INSERT INTO gpu_samples(ts,sample) VALUES (?,?)',
    ((NOW - 7 * DAY + i * 15000, json.dumps(dict(index=0, memory_used_mib=1000 + i % 800,
       memory_total_mib=24000, utilization_percent=i % 100, temperature_c=50, power_w=150)))
     for i in range(40320)))
p = dbs['pricing']
for d in range(365):
    t = (NOW - (365 - d) * DAY) // 1000
    p.execute('INSERT INTO refreshes VALUES (?)', (t,))
    p.executemany('INSERT INTO price_snapshots VALUES (?,?,?,?,?,?,?)',
        ((t, source, f'model-{m}', 2.0 + m / 100, 8.0 + m / 100, t - DAY // 1000, d + 1)
         for m in range(1000) for source in ('openrouter', 'litellm')))
    p.executemany('INSERT INTO reference_selection VALUES (?,?,?,?,?)',
        ((family, f'model-{f}', t, confirmed, d + 1)
         for f, family in enumerate(('Claude Sonnet', 'ChatGPT mid-tier')) for confirmed in (0, 1)))
    p.executemany('INSERT INTO pricing_items VALUES (?,?,?,?,?)',
        ((t, 'warning', 'Claude Sonnet', f'item-{j}', d + 1) for j in range(10)))
for name, db in dbs.items():
    db.commit()
    db.execute('ANALYZE')
    print(name, 'counts', [(t, db.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0])
        for (t,) in db.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")])
    print(name, 'integrity', db.execute('PRAGMA integrity_check').fetchone()[0])
print('SQLite', sqlite3.sqlite_version, 'NOW', NOW)

queries = [
    ('M1', 'meter', 'SELECT id,record FROM requests LIMIT 0', ()),
    ('M2', 'meter', 'SELECT id,record FROM requests ORDER BY id DESC LIMIT 500', ()),
    ('M3', 'meter', 'SELECT id,record FROM requests WHERE id > 364000 ORDER BY id ASC LIMIT 500', ()),
    ('M4', 'meter', 'SELECT id,record FROM requests WHERE ts >= ?1', (NOW - DAY,)),
    ('M5', 'meter', 'SELECT id,record FROM requests WHERE ts >= ?1 AND model = ?2', (NOW - DAY, 'model-1')),
    ('M6', 'meter', 'SELECT id,sample FROM gpu_samples WHERE ts >= ?1 ORDER BY ts,id', (NOW - DAY,)),
    ('M7', 'meter', 'DELETE FROM gpu_samples WHERE ts < ?1', (NOW - 6 * DAY,)),
]
# Extract literal SQL verbatim; exclude bootstrap DDL/PRAGMAs, catalog separately in the document.
for name, file in [('C', 'factory-api/src/data.rs'), ('P', 'pricing/src/lib.rs')]:
    n = 0
    for match in re.finditer(r'"((?:[^"\\]|\\.)*)"', (ROOT / file).read_text()):
        sql = match.group(1)
        if not sql.startswith(('SELECT ', 'INSERT ')):
            continue
        n += 1
        count = max([int(x) for x in re.findall(r'\?(\d+)', sql)] or [0])
        if sql.startswith('INSERT'):
            if 'price_snapshots' in sql:
                args = (NOW // 1000, 'openrouter', 'model-0', 2., 8., NOW // 1000, 365)
            elif 'reference_selection' in sql:
                args = ('Claude Sonnet', 'model-0', NOW // 1000, 365)[:count]
            elif 'pricing_items' in sql:
                args = (NOW // 1000, 'warning', 'Claude Sonnet', 'test', 365)
            elif 'refreshes' in sql:
                args = (NOW // 1000,)
            elif 'warnings' in sql:
                args = ('gap: test',)
            else:
                args = (365001, NOW, '{}')
        elif count:
            if 'family=?1' in sql:
                args = ('Claude Sonnet', NOW // 1000)[:count]
            elif 'model_id=?1' in sql:
                args = ('model-0', NOW // 1000)[:count]
            else:
                args = (NOW - DAY,)
        else:
            args = ()
        queries.append((f'{name}{n}', 'cache' if name == 'C' and n != 4 else 'pricing', sql, args))
queries += [
    ('W1', 'meter', 'INSERT INTO requests(record) VALUES (?1)', ('{}',)),
    ('W2', 'meter', 'INSERT INTO gpu_samples(ts,sample) VALUES (?1,?2)', (NOW, '{}')),
    ('C5-7d', 'cache', 'SELECT record FROM requests WHERE ts_ms>=?1 ORDER BY id', (NOW - 7 * DAY,)),
    ('C5-30d', 'cache', 'SELECT record FROM requests WHERE ts_ms>=?1 ORDER BY id', (NOW - 30 * DAY,)),
]
for key, name, sql, args in queries:
    print('\n' + key, name, 'SQL:', ' '.join(sql.split()), 'PARAMS:', args)
    details = [row[3] for row in dbs[name].execute('EXPLAIN QUERY PLAN ' + sql, args)]
    print('PLAN:', ' | '.join(details) or '(no plan rows; direct VALUES write)')
```

Executed:

```sh
python3 .amp/in/audit.py > .amp/in/artifacts/explain.txt
cat .amp/in/artifacts/explain.txt
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace
```

All three Rust checks passed: 22 tests, zero failures. No source/test code changed.
The reproducible program prints **every actual SQL string and bound parameter**;
the result inventory above transcribes all observed plans. Key raw output:

```text
meter counts [('requests', 365000), ('gpu_samples', 40320)]
meter integrity ok
cache counts [('requests', 365000), ('warnings', 10)]
cache integrity ok
pricing counts [('refreshes', 365), ('price_snapshots', 730000), ('reference_selection', 1460), ('pricing_items', 3650)]
pricing integrity ok
SQLite 3.46.1 NOW 1791720000000
C5 PLAN: SCAN requests
C5-7d PLAN: SCAN requests
C5-30d PLAN: SCAN requests
P13 PLAN: SCAN pricing_items | SCALAR SUBQUERY 1 | SEARCH refreshes
M3 PLAN: SEARCH requests USING INTEGER PRIMARY KEY (rowid>?)
M4 PLAN: SEARCH requests USING INDEX requests_ts (ts>?)
M5 PLAN: SEARCH requests USING INDEX requests_model_ts (model=? AND ts>?)
P3 PLAN: SEARCH price_snapshots USING INDEX snapshot_lookup (model_id=? AND fetched_at<?) | USE TEMP B-TREE FOR LAST 3 TERMS OF ORDER BY
```

Audit scratch program and generated SQLite fixtures are removed after review;
the ignored text receipts remain local artifacts, not a PR dependency. Only
this Markdown and the additive Database rules section are committed.

## Appendix B: bundled SQLite replay and document checks

Save the following executed probe as `.amp/in/explain.c`. It links the **already
compiled Cargo SQLite archive**, opens only fixture paths with SQLITE_OPEN_READONLY,
binds the original INTEGER/REAL/TEXT parameters and prints EQP detail rows.
No new dependency, Rust source change, or production database access is needed.

```c
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
    sqlite3 *db = NULL;
    sqlite3_stmt *statement = NULL;
    if (argc < 3) return 2;
    if (sqlite3_open_v2(argv[1], &db, SQLITE_OPEN_READONLY, NULL) != SQLITE_OK) goto fail;
    printf("SQLite %s\n", sqlite3_libversion());
    if (sqlite3_prepare_v2(db, argv[2], -1, &statement, NULL) != SQLITE_OK) goto fail;
    for (int i = 3; i < argc; i++) {
        int result;
        if (argv[i][0] == 'i') result = sqlite3_bind_int64(statement, i - 2, strtoll(argv[i] + 1, NULL, 10));
        else if (argv[i][0] == 'f') result = sqlite3_bind_double(statement, i - 2, strtod(argv[i] + 1, NULL));
        else result = sqlite3_bind_text(statement, i - 2, argv[i] + 1, -1, SQLITE_TRANSIENT);
        if (result != SQLITE_OK) goto fail;
    }
    int result;
    while ((result = sqlite3_step(statement)) == SQLITE_ROW) {
        printf("%s\n", sqlite3_column_text(statement, 3));
    }
    if (result != SQLITE_DONE) goto fail;
    sqlite3_finalize(statement);
    sqlite3_close(db);
    return 0;
fail:
    fprintf(stderr, "%s\n", db ? sqlite3_errmsg(db) : "open failed");
    sqlite3_finalize(statement);
    sqlite3_close(db);
    return 1;
}
```

Executed build/replay below. Archive/header paths are this checkout's build;
on another machine locate them with `find target/debug/build -path
'*/out/libsqlite3.a'` and the matching libsqlite3-sys registry version. The first
compile without the registry include path failed (`sqlite3.h` missing); adding
the matching include path resolved it. All replay commands then succeeded.

```sh
cc -Wall -Wextra -Werror \
  -I /home/agent/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/libsqlite3-sys-0.36.0/sqlite3 \
  .amp/in/explain.c target/debug/build/libsqlite3-sys-bb69dccaf45d96fc/out/libsqlite3.a \
  -ldl -lpthread -lm -o .amp/in/explain
python3 - <<'PY' > .amp/in/artifacts/explain-bundled.txt
import ast
from pathlib import Path
import subprocess
lines = Path('.amp/in/artifacts/explain.txt').read_text().splitlines()
for index, line in enumerate(lines):
    if ' SQL: ' not in line:
        continue
    head, rest = line.split(' SQL: ', 1)
    key, name = head.split()
    sql, params = rest.split(' PARAMS: ', 1)
    values = ast.literal_eval(params)
    args = [('i' if isinstance(v, int) else 'f' if isinstance(v, float) else 's') + str(v) for v in values]
    result = subprocess.run(['.amp/in/explain', f'.amp/in/artifacts/{name}.db', 'EXPLAIN QUERY PLAN ' + sql, *args], check=True, capture_output=True, text=True)
    rows = result.stdout.splitlines()
    plan = ' | '.join(rows[1:]) or '(no plan rows; direct VALUES write)'
    print(key, rows[0], plan, 'MATCH' if plan == lines[index + 1][6:] else 'DIFF')
PY
cat .amp/in/artifacts/explain-bundled.txt
```

Result: all M1–M7, C1–C6, P1–P13, W1–W2, C5-7d and C5-30d reported
`SQLite 3.51.1 ... MATCH` (30/30). Original plans in the inventory therefore
also describe the bundled library on these fixtures.

Document checks executed all five fenced DDL blocks in empty in-memory SQLite
databases, then compared the three current-schema column/index contracts with
the captures. All passed. These checks validate the written DDL, **not a migration**.
The check also proved the appendix reproducer matches the executed scratch file
and the existing Repository workflow section is byte-for-byte unchanged.

```sh
python3 - <<'PY'
from pathlib import Path
import re, sqlite3, subprocess
s = Path('docs/data-model.md').read_text()
blocks = re.findall(r'```sql\n(.*?)\n```', s, re.S)
assert len(blocks) == 5
for i, block in enumerate(blocks):
    db = sqlite3.connect(':memory:')
    db.executescript(block)
    print('SQL block', i + 1, 'valid')
    if i < 3:
        paths = ['factory-gpu-meter', 'factory-console-requests', 'factory-console-pricing']
        original = sqlite3.connect(':memory:')
        original.executescript(Path('/tmp/live-schemas/' + paths[i] + '.sql').read_text())
        def contract(conn):
            result = {}
            for table, in conn.execute("SELECT name FROM sqlite_schema WHERE type='table'"):
                result[table] = (conn.execute(f'PRAGMA table_xinfo({table})').fetchall(),
                    sorted((row[1], conn.execute(f'PRAGMA index_xinfo("{row[1]}")').fetchall())
                        for row in conn.execute(f'PRAGMA index_list({table})')))
            return result
        assert contract(db) == contract(original), paths[i]
        print(paths[i], 'capture/document columns and indexes match')
assert s.split('```python\n')[1].split('\n```')[0] + '\n' == Path('.amp/in/audit.py').read_text()
old = subprocess.check_output(['git', 'show', 'main:AGENTS.md'], text=True)
assert Path('AGENTS.md').read_text().startswith(old + '\n## Database rules\n')
print('Reproducer matches executed script; original AGENTS section unchanged')
PY
git diff --check
```
