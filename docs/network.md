# Network quality monitoring (draft spec)

Status: spec agreed 2026-10-16. Tracked in Linear.

## Goal

Show how factory-gpu's internet connection behaves now and over time, and say
where a problem is when one happens. A glance at the kiosk answers "is the
network fine?" The `/network` page answers "what happened, when, and was it the
LAN, the ISP, or DNS?"

## Scope

In scope for v1:

- Continuous latency, jitter and packet loss probes from factory-gpu.
- Scheduled throughput tests (download, upload, latency under load).
- A diagnosis of the first failing layer, with outage events.
- A kiosk card, a `/network` drill-down page, and Slack alerts.

Out of scope for v1:

- Probes from factory-console (Wi-Fi). Every table keys rows by `device_id` so it can follow.
- A "run test now" button. The kiosk stays read-only.
- Per-process or per-flow traffic accounting. MET-195 already samples interface rx/tx.

## Domain model

Probes fall into two kinds with different cost, so they get different
schedulers and tables.

### Targets

A fixed registry, ordered by layer. The order drives diagnosis.

| Layer | Target | Probe |
| --- | --- | --- |
| `lan` | Default gateway (eero), discovered from the route table | ICMP |
| `wan` | Two anycast resolvers, e.g. 1.1.1.1 and 8.8.8.8 | ICMP |
| `dns` | Resolve a fixed name through the system resolver | getaddrinfo timing |
| `tailnet` | factory-console over Tailscale | TCP connect to :22 |

Every 30 s, each target gets a burst of 10 probes, 200 ms apart, 1 s timeout.
One sample per target per tick records `sent`, `received`, and
`rtt_min/avg/max/mdev_us`. Jitter is `mdev`.

### Throughput tests

The test runs in-process against Cloudflare's public speed endpoints
(`GET https://speed.cloudflare.com/__down?bytes=N`, `POST .../__up`). That
means no third-party binary and no API key. The endpoint URLs are config,
because Cloudflare publishes no terms or rate limits for programmatic use.

The link is 1 Gb/s fiber, but factory-gpu's NIC is also 1 Gb/s, so the
ceiling we can observe is about 940 Mb/s. Small transfers finish while TCP is
still ramping up, so gigabit needs transfers of 100 MB or more. The test
borrows the method of Cloudflare's MIT-licensed `@cloudflare/speedtest`.
Bandwidth is the 90th percentile of per-request rates. It uses a shorter
sequence.

| Direction | Sequence | Bytes |
| --- | --- | --- |
| Download | 10 MB x4, 25 MB x4, 100 MB x3 | ~440 MB |
| Upload | 10 MB x4, 25 MB x4, 50 MB x3 | ~290 MB |

A full test moves about 0.73 GB and takes roughly 10 s of line-rate
transfer. The sequence stops escalating early if a step already takes more
than 1 s, so a degraded link costs less. While each direction runs, latency to
the `wan` target is measured too, which records bufferbloat. A test outcome is
one of `ok`, `failed` or `timeout`. A failed test keeps its error string and
has null rates. A hard cap of 60 s aborts a test that runs too long.

Cadence: every 3 hours (config, default `10800` s), plus one run 2 minutes after the service starts.

The test does not store the public IP. It stores the Cloudflare colo code only.

### Diagnosis

Each tick reduces the latest per-target samples to one link state. The first
layer, in registry order, that is down or degraded names the fault.

```
Healthy
Degraded { layer, reason: Loss | Latency | Jitter }
Down     { layer }            // 100% loss for >= 2 consecutive ticks
```

Examples. If the gateway is fine but both anycast targets are down, that is
`Down { wan }`, an ISP outage. If ICMP is fine but DNS fails, that is
`Down { dns }`. A state transition opens or closes a `network_events` row with
its start, end, layer and peak values. Thresholds live in config with defaults.

Each target's burst is classified on its own. Nothing received is `Lost`.
Otherwise the first limit reached, in the order loss, latency (average RTT),
jitter (mdev), names `Degraded`. Each limit trips at or above its value.

| Layer | Loss | RTT | Jitter |
| --- | --- | --- | --- |
| `lan` | 20 % | 20 ms | 10 ms |
| `wan` | 20 % | 100 ms | 30 ms |
| `dns` | 20 % | 250 ms | 100 ms |
| `tailnet` | 20 % | 150 ms | 50 ms |

`--network-thresholds` (`FACTORY_API_NETWORK_THRESHOLDS`) overrides layers
with comma-separated `layer:loss/rtt/jitter` entries in integer percent and
milliseconds, such as `wan:30/150/40`. Unlisted layers keep the defaults.
Loss must be 1 to 100, and RTT and jitter 1 to 1000 ms, because every attempt
times out after 1 s.

- A layer is as healthy as its healthiest target. One wan resolver dropping
  ICMP does not blame the ISP; both lost does.
- A layer with no sample this tick is unknown, for example when ping itself is
  broken. Unknown never names a fault.
- A layer is down after 2 consecutive `Lost` ticks. One `Lost` tick is
  `Degraded { loss }`. Any other tick, unknown included, resets the count, so
  recovery takes one good tick.
- The first layer in registry order that is down or degraded names the state,
  so a degraded `lan` masks a down `wan`.
- The `net_events` row for a state stays open while the state holds and
  tracks the peak loss, average RTT and jitter of the faulting layer's chosen
  targets. Recovery closes it as `recovered`. A different state closes it as
  `changed` and opens the next one at the same tick.
- The counts restart with the process, so the first tick closes an event left
  open by the previous process as `restart`.

## Storage (factory-api, versioned migration)

Follows docs/agents/db.md. All tables are STRICT, with `*_ms` timestamps and
bounded retention after rollup. Modeled on `ups_schema.sql`.

| Table | Grain | Retention |
| --- | --- | --- |
| `net_probe_samples` | device, target, 30 s | 7 days |
| `net_probe_rollup_hourly` | device, target, hour; loss %, rtt min/avg/max, p95 mdev | indefinite |
| `net_speed_tests` | one row per test | 365 days |
| `net_events` | one row per state episode | indefinite |

Migration version: 3 if MET-195 (version 2) lands first. Coordinate before merging.

## API

A separate `/v1/network` namespace. Network health is a property of the path,
not of device hardware, so it does not go under `/v1/devices`.

- `GET /v1/network` returns current state, latest sample per target, latest speed test, open event and warnings.
- `GET /v1/network/history?range=1h|24h|7d|30d` returns per-target latency and loss series. Raw data for short ranges, hourly for long ones.
- `GET /v1/network/speed-tests?range=` returns test points for charts.
- `GET /v1/network/events?before=&limit=` returns paged outage and degradation episodes.
- SSE emits `network.sample` and `network.speedtest`.

## Kiosk

- **Card on the dashboard.** It shows a state badge (Healthy, Degraded, Down with layer), the last download and upload rates, and 24 h sparklines for wan latency and loss. It links to `/network`. The 1728×1117 no-scroll layout is tight, so the card must fit the existing grid.
- **`/network` page.** It mirrors `/ups`.
  - Range buttons.
  - Latency and loss chart per layer, with event bands shaded.
  - Throughput chart with loaded-latency overlay.
  - Events table with layer, duration and peak loss.
  - Recent speed tests table.

## Alerts

These use the existing engine, Slack on open and threaded reply on recovery.

- `network:lan_down`, `network:wan_down`, `network:dns_down` fire when an event has stayed open for 2 min or more.
- `network:throughput_low` fires when 3 consecutive `ok` tests come in under 500 Mb/s in either direction. That is about half the observable ceiling for the 1 Gb/s symmetric fiber plan. The threshold is config.
- `network:speedtest_failing` fires when 3 consecutive tests fail. That separates a blocked or changed endpoint from a slow link.

## Verification

- The sandbox has no external network. Exact-command shims and fake HTTP speed endpoints serve fixtures: loss, an outage, a DNS failure, and a slow test.
- Diagnosis is a pure function. Table-driven tests cover each layer combination.
- DB tests are the db.md set: query budgets, EXPLAIN plans, retention boundaries and idempotence.
- Kiosk mock fixtures cover each state. Run `vp check`, `vp test --run` and `vp build`.

## Delivery

Each item is one PR, and each ends with a check.

1. Schema, probe parser, latency sampler, `GET /v1/network` and history.
2. Throughput runner, `net_speed_tests`, speed-test endpoint.
3. Diagnosis reducer, `net_events`, alerts.
4. Kiosk card and `/network` page.

## Decisions

1. Probes run from factory-gpu only in v1. Rows carry `device_id`.
2. The provider is Cloudflare's speed endpoints, called in-process.
3. Speed tests run every 3 hours, about 5.8 GB/day. The latency probes catch outages, so speed tests only need to show the trend.
4. The plan is 1 Gb/s symmetric fiber. `throughput_low` is set at 500 Mb/s.
