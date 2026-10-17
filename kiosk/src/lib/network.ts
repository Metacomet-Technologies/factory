import type {
  NetworkEvent,
  NetworkLayer,
  NetworkLinkState,
  NetworkRange,
  NetworkReason,
  NetworkSeries,
  NetworkSpeedTest,
  NetworkStatus,
  NetworkTarget,
} from "../api/types";
import type { Tone } from "../components/ui/status-chip";

/** Registry order: diagnosis blames the first failing layer. */
export const LAYERS = ["lan", "wan", "dns", "tailnet"] as const satisfies readonly NetworkLayer[];
export const layerLabel: Record<NetworkLayer, string> = {
  lan: "LAN",
  wan: "WAN",
  dns: "DNS",
  tailnet: "Tailnet",
};
const reasonLabel: Record<NetworkReason, string> = {
  loss: "loss",
  latency: "latency",
  jitter: "jitter",
};
const stateTone: Record<NetworkLinkState["state"], Tone> = {
  healthy: "ok",
  degraded: "warn",
  down: "fail",
};
export const linkTone = (link: NetworkLinkState): Tone => stateTone[link.state];

/** Badge text: "Healthy", "Degraded · WAN loss" or "Down · WAN". */
export function linkLabel(link: NetworkLinkState): string {
  switch (link.state) {
    case "healthy":
      return "Healthy";
    case "degraded":
      return `Degraded · ${layerLabel[link.layer]} ${reasonLabel[link.reason]}`;
    case "down":
      return `Down · ${layerLabel[link.layer]}`;
  }
}

/** Episode text without the layer, for tables that show the layer in its own column. */
export function episodeLabel(link: NetworkLinkState): string {
  return link.state === "degraded"
    ? `Degraded · ${reasonLabel[link.reason]}`
    : link.state === "down"
      ? "Down"
      : "Healthy";
}

/** Three 30 s ticks without a sample: the kiosk no longer vouches for the stored state. */
export const NETWORK_STALE_MS = 90_000;

/** The snapshot, or null when no target has a sample from the last 90 s. */
export function freshStatus(
  status: NetworkStatus | null | undefined,
  now: number,
): NetworkStatus | null {
  const newest = Math.max(
    -Infinity,
    ...(status?.targets ?? []).map((target) => target.latest?.ts_ms ?? -Infinity),
  );
  return status && now - newest <= NETWORK_STALE_MS ? status : null;
}

export type NetworkBadge = { label: string; tone: Tone };
/** Pass the result of `freshStatus`; null is "No data". */
export function networkBadge(status: NetworkStatus | null): NetworkBadge {
  return status
    ? { label: linkLabel(status.state), tone: linkTone(status.state) }
    : { label: "No data", tone: "neutral" };
}

export const lossPercent = (burst: { sent: number; received: number }) =>
  burst.sent > 0 ? (100 * (burst.sent - burst.received)) / burst.sent : null;

const lower = (a: number | null, b: number | null | undefined) =>
  b == null ? a : a == null ? b : Math.min(a, b);

/** A layer is as healthy as its healthiest target: its lowest average RTT (ms) and lowest loss (%). */
export function layerNow(targets: NetworkTarget[], layer: NetworkLayer) {
  let latency: number | null = null;
  let loss: number | null = null;
  for (const { layer: at, latest } of targets) {
    if (at !== layer || !latest) continue;
    latency = lower(latency, latest.rtt == null ? null : latest.rtt.avg_us / 1000);
    loss = lower(loss, lossPercent(latest));
  }
  return { latency, loss };
}

export type LayerTrendPoint = { ts_ms: number; latency: number | null; loss: number | null };
/** One point per bucket for a layer, reduced to its healthiest target like `layerNow`. */
export function layerTrend(series: NetworkSeries[], layer: NetworkLayer): LayerTrendPoint[] {
  const points = new Map<number, LayerTrendPoint>();
  for (const line of series) {
    if (line.layer !== layer) continue;
    for (const point of line.points) {
      const merged = points.get(point.ts_ms) ?? { ts_ms: point.ts_ms, latency: null, loss: null };
      merged.latency = lower(merged.latency, point.latency_ms.avg);
      merged.loss = lower(merged.loss, point.loss_percent);
      points.set(point.ts_ms, merged);
    }
  }
  return [...points.values()].sort((a, b) => a.ts_ms - b.ts_ms);
}

export type LayerRow = { ts_ms: number } & Record<
  `latency${number}` | `loss${number}`,
  number | null
>;
/**
 * Chart rows for one layer with a latency and loss column per target. Columns are keyed by
 * index because target names such as 1.1.1.1 contain dots, which Recharts reads as a path.
 */
export function layerRows(series: NetworkSeries[], layer: NetworkLayer) {
  const lines = series.filter((line) => line.layer === layer);
  const rows = new Map<number, LayerRow>();
  lines.forEach((line, index) => {
    for (const point of line.points) {
      const row = rows.get(point.ts_ms) ?? ({ ts_ms: point.ts_ms } as LayerRow);
      row[`latency${index}`] = point.latency_ms.avg ?? null;
      row[`loss${index}`] = point.loss_percent;
      rows.set(point.ts_ms, row);
    }
  });
  return {
    targets: lines.map((line) => line.target),
    rows: [...rows.values()].sort((a, b) => a.ts_ms - b.ts_ms),
  };
}

export type EventBand = {
  id: number;
  layer: NetworkLayer;
  tone: "warn" | "fail";
  x1: number;
  x2: number;
  open: boolean;
};
/** Shaded spans clipped to the chart window [since, now]. An open episode runs to now. */
export function eventBands(events: NetworkEvent[], since: number, now: number): EventBand[] {
  return events.flatMap<EventBand>((event) => {
    if (event.state === "healthy") return [];
    const x1 = Math.max(event.started_ms, since);
    const x2 = Math.min(event.ended_ms ?? now, now);
    if (x2 <= x1) return [];
    const tone = event.state === "down" ? "fail" : "warn";
    return [{ id: event.id, layer: event.layer, tone, x1, x2, open: event.ended_ms == null }];
  });
}

/**
 * Left edge of a chart: the window start, or the oldest point when history is shorter,
 * so a fresh install's few minutes of samples are not a sliver at the right edge.
 */
export function chartStart(since: number, times: number[]): number {
  const first = times.reduce((oldest, time) => Math.min(oldest, time), Infinity);
  return Number.isFinite(first) ? Math.max(since, first) : since;
}

export type SpeedRow = {
  ts_ms: number;
  download: number | null;
  upload: number | null;
  downloadLoaded: number | null;
  uploadLoaded: number | null;
  failed: boolean;
};
/** Throughput chart rows in Mb/s and loaded latency in ms; failed tests keep null rates. */
export function speedRows(tests: NetworkSpeedTest[]): SpeedRow[] {
  return tests.map((test) => ({
    ts_ms: test.started_ms,
    download: test.download_bps == null ? null : test.download_bps / 1e6,
    upload: test.upload_bps == null ? null : test.upload_bps / 1e6,
    downloadLoaded: test.download_loaded_latency_ms ?? null,
    uploadLoaded: test.upload_loaded_latency_ms ?? null,
    failed: test.outcome !== "ok",
  }));
}
export const outcomeTone: Record<NetworkSpeedTest["outcome"], Tone> = {
  ok: "ok",
  failed: "fail",
  timeout: "warn",
};
export const endLabel: Record<NonNullable<NetworkEvent["end_reason"]>, string> = {
  recovered: "Recovered",
  changed: "Changed state",
  restart: "API restarted",
};

export const NETWORK_RANGES = ["1h", "24h", "7d", "30d"] as const satisfies readonly NetworkRange[];
export const rangeMs: Record<NetworkRange, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
};
/** Speed tests run every 3 h, so the 1 h view charts the last day of tests. */
export const speedRange: Record<NetworkRange, Exclude<NetworkRange, "1h">> = {
  "1h": "24h",
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
};
