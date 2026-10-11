# Live pricing report — 2026-10-11

After approval, `config/references.toml` now uses the recommended Sol-only regex.
The capture below preserves the original placeholder run; its Pro selection is
historical, not the current default. A fixture-based resolver regression test
verifies the new default selects GPT 6.1 Sol and excludes other tiers and batch.

## Result and recommendation

Both public sources were fetched without API keys. The successful refresh is
dated `1791695420` (2026-10-11 05:10:20 UTC / 01:10:20 America/New_York).
The unchanged placeholder resolves `openai/gpt-6.1-sol-pro`; its `created`
timestamp is four seconds newer than the ordinary Sol model. Both that model and
`anthropic/claude-sonnet-5.5` publish $2 input / $10 output per million tokens.

Recommend this Rust-compatible regex for **ChatGPT mid-tier**:

```regex
^openai/gpt-[0-9]+(?:\.[0-9]+)?-sol$
```

It currently matches GPT 5.6 Sol, GPT 6 Sol, and GPT 6.1 Sol, and selects
`openai/gpt-6.1-sol`. These direct, non-Pro, non-batch Sol entries all cost
$2/$10 per million input/output tokens, exactly matching current Sonnet's
published base rates. It excludes the cheaper Luna tier, the higher-priced Astra
tier, Pro, batch, image/audio, Codex, OSS, and floating ChatGPT aliases.
This recommendation is based on the live naming and price tiers, not an
independently measured capability benchmark. Future naming changes need review.
**The placeholder was unchanged at capture time; the approved regex is now configured.**

## Schema adaptations and limits

* OpenRouter returns 458 entries; seven routing entries use `-1/-1` prices and
  are excluded. The successful refresh appends 451 usable OpenRouter snapshots.
* LiteLLM returns a model-keyed object with numeric per-token rates and no release
  dates. It yields 108 direct GPT/Sonnet entries. Release dates are joined from
  OpenRouter observations; unknown dates stay null and cannot win resolution.
* Native Anthropic minor-version IDs need hyphen-to-dot normalization. Reseller
  prices are deliberately not treated as direct-provider prices.
* Sonnet 5.5 agrees between sources. LiteLLM has `gpt-6.1-sol` but not the selected
  `gpt-6.1-sol-pro`, so the live cross-check for that Pro ID remains **unverified**
  and is surfaced as a warning. The code does not substitute Sol prices for Pro.
* OpenRouter `created` dates are release proxies, not verified vendor launch dates.
  Long-context price overrides exist in the response; this v1 stores base rates.
  Prompt-caching discounts and non-text charges are not included in savings math.
* Both-source failure and fallback history are exercised offline; a real remote
  outage was not forced. File-backed WAL is verified as `wal`. No production
  database or dashboard was modified.

## Validation

Run from `pricing/`: `cargo fmt --check`,
`cargo clippy --all-targets -- -D warnings`, and `cargo test`.
All pass, with eight offline integration tests. The CLI was also exercised live:
refresh, show before confirmation, both confirmations, show after confirmation,
cost, database environment selection, and an explicit historical timestamp.
250,000 prompt tokens plus 40,000 output tokens cost `0.900000000 USD` for
either confirmed live reference.

The following sections are generated from exact captured CLI stdout and the
successful refresh's SQLite snapshots. Database and raw scratch downloads are
not committed. Commands use the disposable `/tmp/pricing-v1/live.db` database.

## Live refresh

```sh
pricing --db /tmp/pricing-v1/live.db refresh
```

```json
[
  {
    "fetched_at": 1791695420,
    "kind": "pricing.changed",
    "family": "Claude Sonnet",
    "message": "pending anthropic/claude-sonnet-5.5; confirmation required"
  },
  {
    "fetched_at": 1791695420,
    "kind": "pricing.changed",
    "family": "ChatGPT mid-tier",
    "message": "pending openai/gpt-6.1-sol-pro; confirmation required"
  },
  {
    "fetched_at": 1791695420,
    "kind": "warning",
    "family": "ChatGPT mid-tier",
    "message": "openai/gpt-6.1-sol-pro: cross-check unavailable; model missing from a source"
  }
]
```

## Live show: pending

```sh
pricing --db /tmp/pricing-v1/live.db show
```

```json
{
  "families": [
    {
      "family": "Claude Sonnet",
      "pending": {
        "effective_from": 1791695420,
        "model_id": "anthropic/claude-sonnet-5.5"
      },
      "pending_rates": {
        "fetched_at": 1791695420,
        "model": {
          "input_per_mtok": 2.0,
          "model_id": "anthropic/claude-sonnet-5.5",
          "output_per_mtok": 10.0,
          "released_at": 1790618686
        },
        "source": "openrouter"
      },
      "rates": null,
      "selected": null
    },
    {
      "family": "ChatGPT mid-tier",
      "pending": {
        "effective_from": 1791695420,
        "model_id": "openai/gpt-6.1-sol-pro"
      },
      "pending_rates": {
        "fetched_at": 1791695420,
        "model": {
          "input_per_mtok": 2.0,
          "model_id": "openai/gpt-6.1-sol-pro",
          "output_per_mtok": 10.0,
          "released_at": 1790702886
        },
        "source": "openrouter"
      },
      "rates": null,
      "selected": null
    }
  ],
  "items": [
    {
      "family": "Claude Sonnet",
      "fetched_at": 1791695420,
      "kind": "pricing.changed",
      "message": "pending anthropic/claude-sonnet-5.5; confirmation required"
    },
    {
      "family": "ChatGPT mid-tier",
      "fetched_at": 1791695420,
      "kind": "pricing.changed",
      "message": "pending openai/gpt-6.1-sol-pro; confirmation required"
    },
    {
      "family": "ChatGPT mid-tier",
      "fetched_at": 1791695420,
      "kind": "warning",
      "message": "openai/gpt-6.1-sol-pro: cross-check unavailable; model missing from a source"
    }
  ]
}
```

## Confirm Sonnet

```sh
pricing --db /tmp/pricing-v1/live.db confirm 'Claude Sonnet'
```

```json
{
  "model_id": "anthropic/claude-sonnet-5.5",
  "effective_from": 1791695440
}
```

## Confirm ChatGPT

```sh
pricing --db /tmp/pricing-v1/live.db confirm 'ChatGPT mid-tier'
```

```json
{
  "model_id": "openai/gpt-6.1-sol-pro",
  "effective_from": 1791695440
}
```

## Live show: confirmed

```sh
pricing --db /tmp/pricing-v1/live.db show
```

```json
{
  "families": [
    {
      "family": "Claude Sonnet",
      "pending": null,
      "pending_rates": null,
      "rates": {
        "fetched_at": 1791695420,
        "model": {
          "input_per_mtok": 2.0,
          "model_id": "anthropic/claude-sonnet-5.5",
          "output_per_mtok": 10.0,
          "released_at": 1790618686
        },
        "source": "openrouter"
      },
      "selected": {
        "effective_from": 1791695440,
        "model_id": "anthropic/claude-sonnet-5.5"
      }
    },
    {
      "family": "ChatGPT mid-tier",
      "pending": null,
      "pending_rates": null,
      "rates": {
        "fetched_at": 1791695420,
        "model": {
          "input_per_mtok": 2.0,
          "model_id": "openai/gpt-6.1-sol-pro",
          "output_per_mtok": 10.0,
          "released_at": 1790702886
        },
        "source": "openrouter"
      },
      "selected": {
        "effective_from": 1791695440,
        "model_id": "openai/gpt-6.1-sol-pro"
      }
    }
  ],
  "items": [
    {
      "family": "Claude Sonnet",
      "fetched_at": 1791695420,
      "kind": "pricing.changed",
      "message": "pending anthropic/claude-sonnet-5.5; confirmation required"
    },
    {
      "family": "ChatGPT mid-tier",
      "fetched_at": 1791695420,
      "kind": "pricing.changed",
      "message": "pending openai/gpt-6.1-sol-pro; confirmation required"
    },
    {
      "family": "ChatGPT mid-tier",
      "fetched_at": 1791695420,
      "kind": "warning",
      "message": "openai/gpt-6.1-sol-pro: cross-check unavailable; model missing from a source"
    }
  ]
}
```

## Live cost

```sh
pricing --db /tmp/pricing-v1/live.db cost 'Claude Sonnet' 250000 40000
```

```text
0.900000000 USD
```

## All matching OpenRouter models

All 102 IDs matching `^anthropic/claude-sonnet` or `^openai/gpt-`.
Dates are full UTC conversions of OpenRouter `created`. Rates are USD per
million tokens, input then output; all published matching variants are included.

| Model ID | Release proxy (UTC) | Input USD/Mtok | Output USD/Mtok |
| --- | --- | ---: | ---: |
| `openai/gpt-6.1-sol-pro` | 2026-09-29 17:28:06 | 2 | 10 |
| `openai/gpt-6.1-sol-pro:batch` | 2026-09-29 17:28:06 | 1 | 5 |
| `openai/gpt-6.1-sol` | 2026-09-29 17:28:02 | 2 | 10 |
| `openai/gpt-6.1-sol:batch` | 2026-09-29 17:28:02 | 1 | 5 |
| `anthropic/claude-sonnet-5.5` | 2026-09-28 18:04:46 | 2 | 10 |
| `anthropic/claude-sonnet-5.5:batch` | 2026-09-28 18:04:46 | 1 | 5 |
| `openai/gpt-6-luna-pro` | 2026-09-22 18:13:11 | 0.1 | 0.5 |
| `openai/gpt-6-luna-pro:batch` | 2026-09-22 18:13:11 | 0.05 | 0.25 |
| `openai/gpt-6-luna` | 2026-09-22 18:13:06 | 0.1 | 0.5 |
| `openai/gpt-6-luna:batch` | 2026-09-22 18:13:06 | 0.05 | 0.25 |
| `openai/gpt-6-sol-pro` | 2026-09-22 18:13:01 | 2 | 10 |
| `openai/gpt-6-sol-pro:batch` | 2026-09-22 18:13:01 | 1 | 5 |
| `openai/gpt-6-sol` | 2026-09-22 18:12:55 | 2 | 10 |
| `openai/gpt-6-sol:batch` | 2026-09-22 18:12:55 | 1 | 5 |
| `openai/gpt-6-astra` | 2026-09-04 20:13:58 | 10 | 50 |
| `openai/gpt-6-astra:batch` | 2026-09-04 20:13:58 | 5 | 25 |
| `openai/gpt-6-astra-pro` | 2026-09-04 20:13:55 | 10 | 50 |
| `openai/gpt-6-astra-pro:batch` | 2026-09-04 20:13:55 | 5 | 25 |
| `openai/gpt-5.6-luna-pro` | 2026-07-09 09:54:27 | 0.2 | 1.2 |
| `openai/gpt-5.6-luna-pro:batch` | 2026-07-09 09:54:27 | 0.1 | 0.6 |
| `openai/gpt-5.6-luna` | 2026-07-09 09:54:24 | 0.2 | 1.2 |
| `openai/gpt-5.6-luna:batch` | 2026-07-09 09:54:24 | 0.1 | 0.6 |
| `openai/gpt-5.6-terra-pro` | 2026-07-09 09:54:21 | 2 | 12 |
| `openai/gpt-5.6-terra-pro:batch` | 2026-07-09 09:54:21 | 1 | 6 |
| `openai/gpt-5.6-terra` | 2026-07-09 09:54:17 | 2 | 12 |
| `openai/gpt-5.6-terra:batch` | 2026-07-09 09:54:17 | 1 | 6 |
| `openai/gpt-5.6-sol-pro` | 2026-07-09 09:54:14 | 2 | 10 |
| `openai/gpt-5.6-sol-pro:batch` | 2026-07-09 09:54:14 | 1 | 5 |
| `openai/gpt-5.6-sol` | 2026-07-09 09:54:10 | 2 | 10 |
| `openai/gpt-5.6-sol:batch` | 2026-07-09 09:54:10 | 1 | 5 |
| `anthropic/claude-sonnet-5` | 2026-06-30 18:11:23 | 2 | 10 |
| `anthropic/claude-sonnet-5:batch` | 2026-06-30 18:11:23 | 1 | 5 |
| `openai/gpt-chat-latest` | 2026-05-05 16:56:52 | 5 | 30 |
| `openai/gpt-5.5-pro` | 2026-04-24 17:31:36 | 30 | 180 |
| `openai/gpt-5.5-pro:batch` | 2026-04-24 17:31:36 | 15 | 90 |
| `openai/gpt-5.5` | 2026-04-24 17:31:33 | 5 | 30 |
| `openai/gpt-5.5:batch` | 2026-04-24 17:31:33 | 2.5 | 15 |
| `openai/gpt-5.4-image-2` | 2026-04-21 18:52:08 | 8 | 15 |
| `openai/gpt-5.4-nano` | 2026-03-17 11:49:47 | 0.2 | 1.25 |
| `openai/gpt-5.4-nano:batch` | 2026-03-17 11:49:47 | 0.1 | 0.625 |
| `openai/gpt-5.4-mini` | 2026-03-17 11:49:38 | 0.75 | 4.5 |
| `openai/gpt-5.4-mini:batch` | 2026-03-17 11:49:38 | 0.375 | 2.25 |
| `openai/gpt-5.4-pro` | 2026-03-05 18:12:46 | 30 | 180 |
| `openai/gpt-5.4-pro:batch` | 2026-03-05 18:12:46 | 15 | 90 |
| `openai/gpt-5.4` | 2026-03-05 18:12:32 | 2.5 | 15 |
| `openai/gpt-5.4:batch` | 2026-03-05 18:12:32 | 1.25 | 7.5 |
| `openai/gpt-5.3-codex` | 2026-02-24 18:52:44 | 1.75 | 14 |
| `anthropic/claude-sonnet-4.6` | 2026-02-17 15:43:10 | 3 | 15 |
| `anthropic/claude-sonnet-4.6:batch` | 2026-02-17 15:43:10 | 1.5 | 7.5 |
| `openai/gpt-audio` | 2026-01-19 22:42:49 | 2.5 | 10 |
| `openai/gpt-audio-mini` | 2026-01-19 21:50:19 | 0.6 | 2.4 |
| `openai/gpt-5.2-codex` | 2026-01-14 16:48:35 | 1.75 | 14 |
| `openai/gpt-5.2-chat` | 2025-12-10 18:03:03 | 1.75 | 14 |
| `openai/gpt-5.2-pro` | 2025-12-10 18:03:00 | 21 | 168 |
| `openai/gpt-5.2-pro:batch` | 2025-12-10 18:03:00 | 10.5 | 84 |
| `openai/gpt-5.2` | 2025-12-10 18:02:55 | 1.75 | 14 |
| `openai/gpt-5.2:batch` | 2025-12-10 18:02:55 | 0.875 | 7 |
| `openai/gpt-5.1-codex-max` | 2025-12-04 20:08:54 | 1.25 | 10 |
| `openai/gpt-5.1` | 2025-11-13 18:58:25 | 1.25 | 10 |
| `openai/gpt-5.1:batch` | 2025-11-13 18:58:25 | 0.625 | 5 |
| `openai/gpt-5.1-codex` | 2025-11-13 18:58:18 | 1.25 | 10 |
| `openai/gpt-5.1-codex-mini` | 2025-11-13 18:17:00 | 0.25 | 2 |
| `openai/gpt-oss-safeguard-20b` | 2025-10-29 15:47:16 | 0.075 | 0.3 |
| `openai/gpt-5-image-mini` | 2025-10-16 14:23:03 | 2.5 | 2 |
| `openai/gpt-5-image` | 2025-10-14 13:19:46 | 10 | 10 |
| `openai/gpt-5-pro` | 2025-10-06 18:51:03 | 15 | 120 |
| `openai/gpt-5-pro:batch` | 2025-10-06 18:51:03 | 7.5 | 60 |
| `anthropic/claude-sonnet-4.5` | 2025-09-29 16:01:16 | 3 | 15 |
| `anthropic/claude-sonnet-4.5:batch` | 2025-09-29 16:01:16 | 1.5 | 7.5 |
| `openai/gpt-5` | 2025-08-07 17:23:33 | 1.25 | 10 |
| `openai/gpt-5:batch` | 2025-08-07 17:23:33 | 0.625 | 5 |
| `openai/gpt-5-mini` | 2025-08-07 17:23:27 | 0.25 | 2 |
| `openai/gpt-5-mini:batch` | 2025-08-07 17:23:27 | 0.125 | 1 |
| `openai/gpt-5-nano` | 2025-08-07 17:23:22 | 0.05 | 0.4 |
| `openai/gpt-5-nano:batch` | 2025-08-07 17:23:22 | 0.025 | 0.2 |
| `openai/gpt-oss-120b` | 2025-08-05 17:17:11 | 0.037 | 0.17 |
| `openai/gpt-oss-120b:batch` | 2025-08-05 17:17:11 | 0.0296 | 0.136 |
| `openai/gpt-oss-20b` | 2025-08-05 17:17:09 | 0.018 | 0.09 |
| `openai/gpt-oss-20b:batch` | 2025-08-05 17:17:09 | 0.024 | 0.112 |
| `anthropic/claude-sonnet-4` | 2025-05-22 16:12:51 | 3 | 15 |
| `openai/gpt-4.1` | 2025-04-14 17:23:05 | 2 | 8 |
| `openai/gpt-4.1:batch` | 2025-04-14 17:23:05 | 1 | 4 |
| `openai/gpt-4.1-mini` | 2025-04-14 17:23:01 | 0.4 | 1.6 |
| `openai/gpt-4.1-mini:batch` | 2025-04-14 17:23:01 | 0.2 | 0.8 |
| `openai/gpt-4.1-nano` | 2025-04-14 17:22:49 | 0.1 | 0.4 |
| `openai/gpt-4.1-nano:batch` | 2025-04-14 17:22:49 | 0.05 | 0.2 |
| `openai/gpt-4o-2024-11-20` | 2024-11-20 18:33:14 | 2.5 | 10 |
| `openai/gpt-4o-2024-08-06` | 2024-08-06 00:00:00 | 2.5 | 10 |
| `openai/gpt-4o-mini` | 2024-07-18 00:00:00 | 0.15 | 0.6 |
| `openai/gpt-4o-mini-2024-07-18` | 2024-07-18 00:00:00 | 0.15 | 0.6 |
| `openai/gpt-4o-mini:batch` | 2024-07-18 00:00:00 | 0.075 | 0.3 |
| `openai/gpt-4o` | 2024-05-13 00:00:00 | 2.5 | 10 |
| `openai/gpt-4o-2024-05-13` | 2024-05-13 00:00:00 | 5 | 15 |
| `openai/gpt-4o:batch` | 2024-05-13 00:00:00 | 1.25 | 5 |
| `openai/gpt-4-turbo` | 2024-04-09 00:00:00 | 10 | 30 |
| `openai/gpt-4-turbo:batch` | 2024-04-09 00:00:00 | 5 | 15 |
| `openai/gpt-3.5-turbo-0613` | 2024-01-25 00:00:00 | 1 | 2 |
| `openai/gpt-3.5-turbo-instruct` | 2023-09-28 00:00:00 | 1.5 | 2 |
| `openai/gpt-3.5-turbo-16k` | 2023-08-28 00:00:00 | 3 | 4 |
| `openai/gpt-3.5-turbo` | 2023-05-28 00:00:00 | 0.5 | 1.5 |
| `openai/gpt-3.5-turbo:batch` | 2023-05-28 00:00:00 | 0.25 | 0.75 |
| `openai/gpt-4` | 2023-05-28 00:00:00 | 30 | 60 |
