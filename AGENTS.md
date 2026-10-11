# Repository workflow

Before GitHub or Git authentication, run:

```sh
export GH_TOKEN="$AGENT_GH_TOKEN"
gh auth setup-git
```

Never print or commit the token. Work on a feature branch.

This repository is a Rust workspace. Run `cargo fmt --check`,
`cargo clippy --all-targets -- -D warnings`, and `cargo test --workspace` before pushing.
Do not run deployment scripts or change the running Ollama without explicit permission.

## Database rules

Follow [the data-model plan](docs/data-model.md). These rules govern new DB work;
MET-92 steps 3–5 add the enforcement below and migrate the audited legacy tables.
Do not claim the planned tests already exist. SQLite stays; no Valkey/Redis or
partitioning. Postgres is the escalation path after measured SQLite limits.

| Rule | Enforcement |
| --- | --- |
| No N+1; bounded query counts | Shared counter on every connection, scoped across threads/DBs; endpoint/job tests enforce the plan's budgets at small and large input sizes. CI fails on excess statements, including repeated prepared executions. |
| Index hot queries | Parameter-bound `EXPLAIN QUERY PLAN` tests on realistic analyzed fixtures with bundled SQLite reject unrestricted hot-table scans and avoidable sorts. Document exceptions for LIMIT 0, bounded rowid walks, small whole-set reads and migration scans. |
| Versioned migrations only | Shared ordered runner plus per-DB `user_version`; no handler-time DDL. CI tests empty DBs and captured production-schema fixtures, reruns, failure rollback and version rejection. Before each production migration require a fresh verified MET-74 snapshot; verify row counts and invariants afterward, with tested rollback. |
| STRICT application tables | Migration schema tests assert STRICT, explicit types, PK/FKs and required CHECK constraints; invalid-input tests verify trust boundaries. SQLite internal tables are exempt. |
| UTC millisecond timestamps | Store timestamps as INTEGER `*_ms`; migration and boundary tests check units, overflow and timezone handling. Ollama durations may remain explicit INTEGER `*_ns`; they are not timestamps. |
| Integer money | Store rates per Mtok and request costs as INTEGER micro-dollars; use checked integer calculations/totals and tested per-request rounding. Schema/input tests reject floating-point money storage; USD floats are presentation only. |
| Shared PRAGMAs and pool | All owners use the shared helper: WAL, synchronous=NORMAL, busy_timeout=5000, foreign_keys=ON, journal_size_limit, optimize/checkpoint policy; one writer plus readers on dedicated blocking threads. Tests verify each connection, writer visibility, bounded queues and Tokio isolation. |
| Retention after rollups | Scheduled, bounded, transactional jobs retain raw requests 365 days and raw GPU samples 7 days; request hourly/daily and GPU hourly rollups stay indefinitely. Tests prove counts/costs, cutoff boundaries, restart idempotence, late arrivals and no pruning before committed aggregation. Every table has a documented rule. |
| Explicit ownership and attribution | Meter owns raw facts; API owns its copy and frozen per-family costs; pricing owns rate/selection history. Migration/contract tests preserve IDs and nullable `user_key` plus checked `actor_kind` (human, agent, unattributed); unknown users stay NULL/unattributed. |
