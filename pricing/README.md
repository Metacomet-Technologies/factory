# pricing

A Rust library and CLI for estimating spend avoided by running local Ollama
tokens instead of reference frontier models. It is a member of the root Cargo
workspace; there is no meter integration, scheduler, or dashboard in this package.

## Run

From `pricing/`:

```sh
cargo run -p factory-api -- migrate --pricing-db ./pricing.db
cargo run -- refresh
cargo run -- show
cargo run -- confirm 'Claude Sonnet'
cargo run -- confirm 'ChatGPT mid-tier'
cargo run -- cost 'Claude Sonnet' 250000 40000
cargo run -- cost 'Claude Sonnet' 250000 40000 --at 1791695440
cargo run -- cost 'Claude Sonnet' 250000 40000 --at-ms 1791695440123
cargo run -- cost 'Claude Sonnet' 250000 40000 --at 2026-10-11T01:10:40-04:00
```

The binary is named `pricing`. Database precedence is `--db`, then `PRICING_DB`,
then `./pricing.db`. Both `--db` and `--config` work before or after the subcommand.
Family names containing spaces must be quoted. `--at` takes Unix seconds or
RFC3339 with an explicit timezone; `--at-ms` takes Unix milliseconds. All stored
timestamps and library arguments use UTC milliseconds. Runtime opens require v1.
Migration refuses legacy databases without writes: move the old file and WAL/SHM
aside first, then migrate, refresh, and confirm. The installer preserves both a
verified backup and `pricing.v0.db`; no legacy rows are copied.

`config/references.toml` supplies the bundled defaults. To load edits without
rebuilding, pass `--config config/references.toml` (or another TOML file).
ChatGPT mid-tier uses `^openai/gpt-[0-9]+(?:\.[0-9]+)?-sol$`, selecting ordinary
Sol models and excluding Pro, Luna, Astra, and batch variants. See
[the live report](LIVE_REPORT.md) for the original recommendation and capture.

## Library

```rust,no_run
use pricing::Store;

let store = Store::open("pricing.db")?;
let nano_usd = store.cost("Claude Sonnet", 250_000, 40_000, 1_791_695_440_000)?;
let usd = nano_usd.display_usd();
# Ok::<(), anyhow::Error>(())
```

`parse_references`, `parse_openrouter`, `parse_litellm`, `resolve`, `Store::refresh`,
and `fetch_live` are also public. `Store::refresh` accepts already parsed feeds
for offline ingestion. `Store::show` exposes active and pending selections and
their rates; `Store::items` returns events from the latest successful refresh.

## Sources and decisions

* Primary: `https://openrouter.ai/api/v1/models`, without authentication.
  Its `data` array has model `id`, Unix-seconds `created`, and string-valued
  `pricing.prompt` / `pricing.completion` in USD per token. Exact decimal scaling
  by 10^12 produces integer micro-USD per million tokens. Live routing entries report
  `-1/-1`; they have no usable fixed rates and are excluded. Other negative,
  nonfinite, malformed, overflowing, or fractional-micro-unit rates reject the
  feed rather than polluting history. No money parsing passes through f64.
* Secondary: `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`.
  This is a model-keyed object, not an array. Rates are numeric
  `input_cost_per_token` / `output_cost_per_token`. Only direct `openai` GPT and
  direct `anthropic` Sonnet entries are used, not reseller or regional prices.
  Sonnet minor versions use hyphens in native Anthropic IDs (`5-5`) and dots in
  OpenRouter IDs (`5.5`); the parser normalizes that difference.
* LiteLLM has **no release-date field**. Refresh attaches the OpenRouter date
  from the current response or stored history. An unseen LiteLLM-only model has
  `released_at_ms = NULL` and cannot win the newest-release resolver. A first-ever
  refresh during an OpenRouter outage records fallback prices and unresolved
  warnings, rather than inventing release dates. Historical fallback works once
  dates have been observed. Unmapped aliases also remain unresolved.
* `created` is used as the release-date proxy, as requested. Provider launch
  dates have not been independently verified. Equal timestamps use lexical ID
  order, preferring the plain model to its same-date `:batch` variant. Otherwise
  the regex controls eligibility; there is no hidden tier or modality filter.
* Refresh checks both the confirmed model and the proposed replacement. A
  difference **strictly greater than 5%** on either rate records a warning;
  OpenRouter is the denominator and remains authoritative for that fetch.
  A missing counterpart records a cross-check-unavailable warning, not agreement.
* A model change, including the first selection, appends an unconfirmed row and
  a `pricing.changed` event. `confirm` appends a confirmed row effective at the
  confirmation time; it does not backdate activation to discovery or release.
  Repeated refreshes re-observe pending changes. Only the latest refresh's
  candidate can be confirmed. Withdrawn candidates remain historical rows but
  are no longer actionable.
* `show.items` contains dated refresh events, not a live task queue. A historical
  `pricing.changed` event can remain after confirmation. The family's `pending`
  field is the authoritative current confirmation state.

## History and cost contract

SQLite uses bundled SQLite, shared `factory-db` settings and atomic immediate
transactions for refresh and confirmation. The API and CLI use dedicated writer
and reader workers. Feed fetching happens before submitting writes. The in-memory
test database uses SQLite's memory journal instead of WAL.

`price_snapshots` and `reference_selection` contain the requested columns.
Additional `refresh_id` columns and the small `refreshes` table distinguish fetches
within the same millisecond. Tables are STRICT with explicit IDs and foreign keys.
`pricing_items` retains warnings and change events. All
writes append; no snapshot, selection, or event is updated or deleted. Failed
refreshes leave existing history intact. Backdated writes are rejected.

Cost first selects the last **confirmed** family model effective at or before
the requested timestamp. It then selects that model's latest rate observation
at or before the same timestamp. Within one fetch, OpenRouter wins over LiteLLM;
a later fallback fetch wins over an older primary observation. A rate change for
the same confirmed model takes effect at fetch time without another confirmation.
Old cost queries continue to use old observations and selections.

`nano-USD = (prompt_tokens * input_micro_usd_per_mtok + output_tokens * output_micro_usd_per_mtok + 500) / 1000`

The result is checked `NanoUsd`, rounded half-up once per request. Totals use
checked integer sums; only CLI/HTTP presentation converts to USD floats. Prompt-caching discounts
are intentionally ignored. Only base text-token rates are used: long-context
pricing overrides, priority/flex service, tools, image charges, and audio charges
are not modeled. A regex that selects a batch model uses that ID's published
base rates. This estimates reference spend; it does not reproduce provider bills.

Before the first confirmation, or before any applicable observed rate, `cost`
returns an error. No attempt is made to reconstruct prices before collection
started. Later queries carry the last observation forward until another fetch;
its age is visible in `show.rates.fetched_at_ms`.

## Verification

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Offline tests cover real-feed parsing, newest-wins and tie resolution, pending
and confirmed changes, the strict cross-check threshold, rate/model history,
fallback dates, same-second refreshes, invalid-input rollback, and CLI behavior.
Fixtures retain relevant entries from both live responses, with irrelevant
OpenRouter fields removed; the unpriced routing entry and LiteLLM non-native
entries remain as parser controls. They require no network or API keys.

Exact live commands, outputs, all matching IDs, dates, and rates are in
[LIVE_REPORT.md](LIVE_REPORT.md). Live validation uses a disposable database,
not a committed database or a production selection.

## Future

* Consume this package from the dashboard/factory-api.
* Schedule refreshes and route `pricing.changed` items to an operator inbox.
* Add independently dated LiteLLM aliases or another authoritative release source
  if first-run outage resolution becomes necessary.
* Model long-context tiers or caching only if bill-equivalent estimates are needed.
