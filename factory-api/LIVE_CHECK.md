# Factory API live check

Executed on factory-console on 2026-10-11, approximately 05:53–05:55 UTC
(01:53–01:55 America/New_York). No installation, sudo, service restart, firewall
change, meter change, or pricing confirmation was performed.

## Commands

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace
bash -n deploy/install-factory-api.sh deploy/rollback-factory-api.sh
cargo build --locked -p factory-api

temp=$(mktemp -d /tmp/factory-api-live.XXXXXX)
target/debug/factory-api --listen 0.0.0.0:18080 \
  --meter-url http://factory-gpu:11434 \
  --db-path "$temp/requests.db" --pricing-db-path "$temp/pricing.db"

curl -fsS http://127.0.0.1:18080/v1/fleet
curl -fsS 'http://127.0.0.1:18080/v1/llm/usage?range=24h'
curl -fsS http://127.0.0.1:18080/v1/gpu
curl -fsS http://127.0.0.1:18080/v1/pricing
curl -fsS -X POST http://127.0.0.1:18080/v1/pricing/refresh
curl -N -sS --max-time 20 http://127.0.0.1:18080/v1/stream
```

The deliberate SSE time limit returns curl status 28 after 20 seconds. It is not
an API failure. The captured stream contains JSON events and a keepalive comment.

## Observed responses

Health returned HTTP 200:

```json
{"status":"ok","version":"0.1.0","uptime_ms":18074}
```

Fleet returned HTTP 200 with both configured nodes online:

- factory-gpu, `100.64.236.114`, Linux: meter-http, ollama-http, ssh-tcp and
  rdp (X.224 negotiation canary) all healthy.
- factory-console, `100.97.7.82`, Linux: rdp (X.224 negotiation canary),
  amp-runner and factory-api healthy. ssh-tcp failed with
  `Connection refused (os error 111)`.
- Both `last_seen_ms` values were null. Every service included kind, target,
  latency, detail and checked-at timestamp. The self-check used port 18080.

Usage returned HTTP 200:

```json
{
  "range": "24h",
  "generated_at_ms": 1791698035719,
  "totals": {"requests": 3, "prompt_tokens": 18, "output_tokens": 31},
  "spend_avoided": [
    {"family":"Claude Sonnet","model_id":null,"usd":0.0,"estimated_usd":0.0,"unpriced_requests":3},
    {"family":"ChatGPT mid-tier","model_id":null,"usd":0.0,"estimated_usd":0.0,"unpriced_requests":3}
  ],
  "models": [
    {"model":null,"requests":2,"prompt_tokens":0,"output_tokens":0,"avg_prompt_tps":null,"avg_gen_tps":null,"p50_latency_ms":0.229547,"p95_latency_ms":0.460396,"total_load_ms":-0.0},
    {"model":"factory-assist","requests":1,"prompt_tokens":18,"output_tokens":31,"avg_prompt_tps":129.03595802030165,"avg_gen_tps":59.25801332589999,"p50_latency_ms":6301.823696,"p95_latency_ms":6301.823696,"total_load_ms":5637.770864}
  ],
  "warnings": []
}
```

This was a fresh pricing database with no confirmed selections, so all requests
were correctly unpriced. Fleet's required Ollama version check itself passes
through meter; subsequent usage snapshots can therefore gain non-model requests.

GPU returned HTTP 200. Current data:

```json
{
  "memory_used_mib":181.0,
  "memory_total_mib":12288.0,
  "utilization_percent":0.0,
  "temperature_c":40.0,
  "power_w":8.22,
  "ts_ms":1791698035761
}
```

`loaded_models` was empty. History contained 71 samples; first timestamp
1791696985299, last 1791698035307. Each history entry contained exactly `ts_ms`,
`memory_used_mib`, `utilization_percent`, `temperature_c`, and `power_w`.

GET pricing returned pending Sonnet 5.5 and GPT-6.1 Sol from startup refresh.
The explicit POST refresh returned HTTP 200 with no warnings:

```json
{
  "families": [
    {"family":"Claude Sonnet","selected":null,"rates":null,"pending":{"model_id":"anthropic/claude-sonnet-5.5","effective_from_ms":1791698035000}},
    {"family":"ChatGPT mid-tier","selected":null,"rates":null,"pending":{"model_id":"openai/gpt-6.1-sol","effective_from_ms":1791698035000}}
  ],
  "warnings": []
}
```

No family was confirmed. Millisecond timestamps end in 000 because pricing
records whole seconds, not because factory-api invents finer precision.

The 20-second SSE capture:

```text
event: llm.request
data: {"type":"llm.request","ts_ms":1791698047686,"data":{"client_hostname":"factory-console","latency_ms":0.496575,"model":null,"output_tokens":null,"prompt_tokens":null}}

event: gpu.sample
data: {"type":"gpu.sample","ts_ms":1791698047721,"data":{"memory_total_mib":12288.0,"memory_used_mib":181.0,"power_w":8.17,"temperature_c":40.0,"ts_ms":1791698047716,"utilization_percent":0.0}}

: keepalive
```

## Verification limits

All workspace tests, formatting and warning-free clippy passed. Integration tests
use an axum mock meter and offline pricing ingestion; they exercise every v1
endpoint, including explicit confirmation in a disposable test database.
Live checks use the real meter and real pricing feeds, without confirmation.

Service-user access and installation/rollback runtime behavior remain unverified:
deployment scripts were written and syntax-checked, not executed. The installer
contains the requested post-start checks. No API-contract fields were added or
renamed. Cargo.lock has only the new workspace package entry, a necessary
generated metadata change beyond the requested source-file isolation.
