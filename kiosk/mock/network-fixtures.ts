import type {
  Endpoints,
  NetworkEvent,
  NetworkLinkState,
  NetworkRange,
  NetworkSample,
  NetworkSpeedTest,
} from "../src/api/types.ts";

export const networkScenarios = [
  "healthy",
  "loss",
  "latency",
  "jitter",
  "lan-down",
  "wan-down",
  "dns-down",
  "tailnet-down",
  "unknown",
  "no-speed-test",
  "slow",
  "empty-events",
] as const;
export type NetworkScenario = (typeof networkScenarios)[number];

const targets = [
  { layer: "lan", target: "gateway", probe: "icmp", rtt: 0.8 },
  { layer: "wan", target: "1.1.1.1", probe: "icmp", rtt: 11 },
  { layer: "wan", target: "8.8.8.8", probe: "icmp", rtt: 14 },
  { layer: "dns", target: "example.com", probe: "resolve", rtt: 18 },
  { layer: "tailnet", target: "factory-console", probe: "tcp_connect", rtt: 4 },
] as const;
const spans: Record<NetworkRange, { span: number; step: number }> = {
  "1h": { span: 3_600_000, step: 30_000 },
  "24h": { span: 86_400_000, step: 120_000 },
  "7d": { span: 604_800_000, step: 3_600_000 },
  "30d": { span: 2_592_000_000, step: 3_600_000 },
};

function openState(scenario: NetworkScenario): NetworkLinkState {
  switch (scenario) {
    case "loss":
    case "latency":
    case "jitter":
      return { state: "degraded", layer: "wan", reason: scenario };
    case "lan-down":
      return { state: "down", layer: "lan" };
    case "wan-down":
      return { state: "down", layer: "wan" };
    case "dns-down":
      return { state: "down", layer: "dns" };
    case "tailnet-down":
      return { state: "down", layer: "tailnet" };
    default:
      return { state: "healthy" };
  }
}

/** 45 closed episodes over the last 30 days, plus the scenario's open one, newest first. */
function allEvents(scenario: NetworkScenario, now: number): NetworkEvent[] {
  if (scenario === "empty-events") return [];
  const layers = ["wan", "lan", "dns", "tailnet"] as const;
  const reasons = ["loss", "latency", "jitter"] as const;
  const closed: NetworkEvent[] = Array.from({ length: 45 }, (_, i) => {
    const started_ms = now - 3_600_000 * (3 + i * 15);
    const layer = layers[i % 4]!;
    const state: NetworkLinkState =
      i % 5 === 0
        ? { state: "down", layer }
        : { state: "degraded", layer, reason: reasons[i % 3]! };
    return {
      ...state,
      id: 100 - i,
      started_ms,
      ended_ms: started_ms + 60_000 * (2 + (i % 7) * 4),
      end_reason: i % 9 === 4 ? "restart" : i % 6 === 2 ? "changed" : "recovered",
      peak_loss_percent: state.state === "down" ? 100 : 10 + (i % 4) * 7,
      peak_rtt_us: state.state === "down" ? null : 40_000 + i * 900,
      peak_mdev_us: state.state === "down" ? null : 6_000 + i * 300,
    };
  });
  const state = openState(scenario);
  if (state.state === "healthy") return closed;
  return [
    {
      ...state,
      id: 101,
      started_ms: now - 420_000,
      ended_ms: null,
      end_reason: null,
      peak_loss_percent: state.state === "down" ? 100 : 30,
      peak_rtt_us: state.state === "down" ? null : 250_000,
      peak_mdev_us: state.state === "down" ? null : 45_000,
    },
    ...closed,
  ];
}

function speedTests(scenario: NetworkScenario, now: number): NetworkSpeedTest[] {
  if (scenario === "no-speed-test") return [];
  // Every 6 hours for 30 days, oldest first; one failure a day ago.
  return Array.from({ length: 120 }, (_, i) => {
    const started_ms = now - 6 * 3_600_000 * (119 - i) - 600_000;
    const failed = i === 115;
    const slow = scenario === "slow" && i === 119;
    return {
      id: 1000 + i,
      started_ms,
      ended_ms: started_ms + 24_000,
      outcome: failed ? "failed" : "ok",
      error: failed ? "HTTP 500 from speed endpoint" : null,
      colo: "SJC",
      download_bps: failed ? null : slow ? 48_000_000 : 910_000_000 + (i % 7) * 9_000_000,
      upload_bps: failed ? null : slow ? 47_000_000 : 395_000_000 + (i % 5) * 6_000_000,
      download_bytes: failed ? 1_000_000 : 250_000_000,
      upload_bytes: failed ? 0 : 100_000_000,
      idle_latency_ms: failed ? null : 11 + (i % 3),
      download_loaded_latency_ms: failed ? null : 24 + (i % 6) * 3,
      upload_loaded_latency_ms: failed ? null : 31 + (i % 4) * 4,
    };
  });
}

/** Network endpoints for the mock API and tests, keyed by a diagnosis scenario. */
export function networkFixtures(scenario: NetworkScenario = "healthy", now = Date.now()) {
  const events = allEvents(scenario, now);
  const tests = speedTests(scenario, now);
  const state = openState(scenario);
  const faulted = (layer: string) => state.state !== "healthy" && state.layer === layer;
  const latest = (target: (typeof targets)[number]): NetworkSample | null => {
    if (scenario === "unknown") return null;
    const down = state.state === "down" && (faulted(target.layer) || state.layer === "lan");
    const lossy = scenario === "loss" && target.layer === "wan";
    const rtt = scenario === "latency" && target.layer === "wan" ? 250 : target.rtt;
    const jitter = scenario === "jitter" && target.layer === "wan" ? 45 : target.rtt / 10;
    return {
      layer: target.layer,
      target: target.target,
      address: target.layer === "lan" ? "192.168.4.1" : null,
      ts_ms: now - 12_000,
      sent: 10,
      received: down ? 0 : lossy ? 7 : 10,
      rtt: down
        ? null
        : {
            min_us: Math.round(rtt * 800),
            avg_us: Math.round(rtt * 1000),
            max_us: Math.round(rtt * 1400),
            mdev_us: Math.round(jitter * 1000),
          },
    };
  };
  const status: Endpoints["/v1/network"] = {
    device_id: "factory-gpu",
    generated_at_ms: now,
    state,
    open_event: events.find((event) => event.ended_ms == null) ?? null,
    latest_speed_test: tests.at(-1) ?? null,
    targets: targets.map((target) => ({
      layer: target.layer,
      target: target.target,
      probe: target.probe,
      latest: latest(target),
    })),
    warnings: scenario === "unknown" ? ["ping failed without a summary"] : [],
  };
  const history = (range: NetworkRange): Endpoints["/v1/network/history"] => {
    const { span, step } = spans[range];
    const count = Math.floor(span / step);
    return {
      range,
      resolution: range === "7d" || range === "30d" ? "hourly" : "raw",
      series:
        scenario === "unknown"
          ? []
          : targets.map((target, t) => ({
              layer: target.layer,
              target: target.target,
              points: Array.from({ length: count }, (_, i) => {
                const ts_ms = now - span + i * step;
                const hit = events.some(
                  (event) =>
                    event.state !== "healthy" &&
                    event.layer === target.layer &&
                    ts_ms >= event.started_ms &&
                    ts_ms <= (event.ended_ms ?? now),
                );
                const wave = 1 + 0.25 * Math.sin((i + t * 7) / 9);
                return {
                  ts_ms,
                  sample_count: range === "1h" ? 1 : step / 30_000,
                  loss_percent: hit ? 30 : 0,
                  jitter_ms: (target.rtt / 10) * wave,
                  latency_ms: {
                    min: target.rtt * 0.8,
                    avg: target.rtt * wave * (hit ? 3 : 1),
                    max: target.rtt * 1.6,
                  },
                };
              }),
            })),
    };
  };
  const speed = (range: string): Endpoints["/v1/network/speed-tests"] => {
    const span = { "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 }[range];
    return { range, tests: tests.filter((test) => span == null || test.started_ms >= now - span) };
  };
  const eventPage = (before: number | null, limit = 50): Endpoints["/v1/network/events"] => {
    const start = before == null ? 0 : events.findIndex((event) => event.id === before) + 1;
    const page = events.slice(start, start + limit);
    return {
      events: page,
      next_before: start + limit < events.length ? (page.at(-1)?.id ?? null) : null,
    };
  };
  return { status, history, speed, eventPage };
}
