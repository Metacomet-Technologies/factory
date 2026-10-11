# Phase 1 live validation

Validated on factory-gpu on 2026-10-11 against real Ollama 0.40.2 and the RTX
3060 12GB. The **release binary** listens on :11500, forwards to the unchanged
Ollama on 127.0.0.1:11434, and uses a disposable SQLite database. No installer,
rollback, sudo, system configuration edits, or model modifications were run.

## Checks

- `cargo fmt --check`: passed.
- `cargo clippy --all-targets -- -D warnings`: passed.
- `cargo test`: passed, two usage unit tests and three HTTP integration tests.
- `python3 -B deploy/test_set_ollama_host.py`: passed. Checks preservation of
  unrelated variables/comments/line endings, repeated install, and rollback
  using temporary fixtures matching the existing Ollama drop-in.
- `bash -n deploy/install-meter.sh deploy/rollback-meter.sh`: passed.
- `cargo build --release --locked -p meter`: passed.

The slow mock upstream sends its first NDJSON frame immediately and the next
two at 350 ms intervals. The HTTP integration test requires first arrival
before 250 ms, second arrival between 300 and 650 ms, and final arrival after
650 ms. It then checks exactly one persisted row, tokens, status, identity,
and rates through meter's HTTP API. A separate integration test checks
asymmetric latency quantiles, rates, missing/zero durations, and model filters.
An induced SQLite write failure returns 503 from health without changing the
upstream response. GPU retention is tested with an eight-day-old sample.

## Real generation responses

Both requests use:

```json
{"model":"factory-assist","prompt":"Reply exactly METER_OK.","stream":false,"think":false,"options":{"num_predict":12,"temperature":0,"seed":42}}
```

Non-streaming response (selected fields; context omitted here):

```json
{"model":"factory-assist","response":"METER_OK","done":true,"done_reason":"stop","total_duration":177556765,"load_duration":1883011,"prompt_eval_count":16,"prompt_eval_duration":77454000,"eval_count":9,"eval_duration":96724000}
```

With `stream:true`, client-observed NDJSON arrival times from POST start:

```text
120.206 ms  response="M"     done=false
167.590 ms  response="ETER"  done=false
167.682 ms  response="_"     done=false
167.706 ms  response="OK"    done=false
168.172 ms  response=""      done=true
```

The first chunk reaches the client 47.966 ms before completion. Joined output
is `METER_OK`, with 16 prompt tokens and 9 generated tokens in the final chunk.
Both completed requests have SQL rows, status 200, and their correct stream
flags. The real API returns the following immediately afterward:

```json
[{"avg_generation_tokens_per_second":94.44439120191228,"avg_prompt_tokens_per_second":217.05113732175994,"input_tokens":32,"model":"factory-assist","output_tokens":18,"p50_total_latency_ms":167.397398,"p95_total_latency_ms":177.556765,"requests":2}]
```

Before the proxy, direct Ollama `/meter/health` returns 404. Through meter,
health returns `{"status":"ok"}` and `/api/version` remains `{"version":"0.40.2"}`.
SQLite independently reports `journal_mode=wal` and the same token/stream rows.

## Additional real paths

- `/api/chat`: both modes return 200 with 15 input and 9 output tokens.
  Streaming begins at 116.527 ms and finishes at 164.265 ms.
- `/v1/chat/completions`: both modes return 200 with 22 input and 12 output
  tokens. SSE begins at 118.437 ms and finishes at 239.956 ms.
- `/v1/completions`: both modes return 200 with 22 input and 12 output tokens.
  SSE begins at 114.447 ms and finishes at 244.905 ms.
- OpenAI streams with `stream_options.include_usage=true` preserve the complete
  usage object, including `total_tokens` and `prompt_tokens_details`.
- An OpenAI stream without usage requested has null input tokens, output
  tokens, and usage in its stored row; meter does not inject usage options.
- A request over this host's Tailscale IP records client IP `100.64.236.114`
  and hostname `factory-gpu`; loopback requests fall back to `127.0.0.1`.
- `/meter/gpu` reports NVIDIA memory used/total of 9502/12288 MiB, utilization
  93%, temperature 57 °C, and power 39.43 W in the captured sample. Its raw
  `/api/ps` object reports gemma4's size/size_vram as 1031693925 bytes; meter
  does not use that erroneous figure for NVIDIA memory. Sampling/history work.
- `/meter/openapi.json` contains all six internal GET paths and shared schemas.
- A raw HTTP/1.1 mock check preserves status 207, custom headers, exact upload
  bytes/query, streamed NDJSON, and the `X-Checksum: exact` response trailer.
  Receive events occur at 0.847, 0.859, 301.500, and 602.211 ms. The recorded
  row retains 17 input and 7 output tokens. This check uses a separate temporary
  proxy and Python mock server; it does not touch Ollama.

## Added latency

Measured with Python `http.client`, reading the complete non-streaming body,
over separate warm persistent loopback connections to direct Ollama and meter.
Each pair alternates direct-first/proxy-first to reduce drift bias. GPU
sampling and request logging remain enabled; the SQLite writer is active.

- `/api/version`, 300 pairs: direct median **0.117209 ms**, proxy median
  **0.185759 ms**, median paired difference **0.063169 ms**.
- `/api/generate`, 40 pairs: `factory-assist`, the same prompt/options above
  with `num_predict=1`, non-streaming, after three warmups on each connection.
  Direct median **67.056103 ms**, proxy median **67.353760 ms**, median paired
  difference **0.155269 ms**. This meets the **<2 ms median** target.
- Subtracting each response's independently reported Ollama `total_duration`
  before comparing leaves a median paired transport/proxy difference of
  **0.205633 ms**. This helps separate inference timing noise from proxy cost.

The paired-difference median is not the difference of the two individual
medians. Raw timing samples are retained in the thread's review artifacts.
These are local unloaded measurements, not a tailnet or concurrency benchmark.

## Unverified and interpretation choices

- Deployment and rollback scripts were **not run**. Dedicated-user GPU and
  Tailscale access, systemd filesystem isolation, production port migration,
  service restart behavior, and full installer idempotence remain unverified.
  Only script syntax and the temporary drop-in editor fixtures were exercised.
- Remote-client/firewall reachability on :11500 and sustained concurrent load
  were not exercised. Hostname resolution was checked using this host's own
  Tailscale address, not a separate remote peer.
- No real embedding workload or model pull/delete/create was exercised.
  Arbitrary endpoint/body/header/status and trailer pass-through have mock coverage.
- HTTP header values and body bytes are preserved, not literal wire casing,
  ordering, transfer framing, or TCP chunk boundaries. Hyper handles those.
- The proxy never waits for the full response before forwarding. It does keep
  metadata copies of request JSON/non-streaming usage JSON, and partial
  NDJSON/SSE lines, in memory while parsing. This is not output buffering.
- Rates are arithmetic means of valid per-request rates; latency percentiles
  use Ollama total duration when available, measured wall time otherwise.
- The asynchronous queue is not durable under forced termination or disk
  failure. Failed writes are logged and make database endpoints unhealthy.
  Request retention is intentionally unspecified; only GPU history expires.

No pricing, factory-api, firewall changes, or additional product features were added.
