import type {
  NetworkEvent,
  NetworkLinkState,
  NetworkRange,
  NetworkSeries,
  NetworkStatus,
} from "../api/types";
import type { Tone } from "../components/ui/status-chip";
import { number } from "./format";

export const NETWORK_RANGE_MS: Record<NetworkRange, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
};

/** Probes tick every 30 s; four missed ticks means the reading no longer describes the link. */
export const NETWORK_STALE_MS = 120_000;

/** The badge words for a link state, straight from the API's diagnosis. */
export function stateLabel(state: NetworkLinkState): string {
  if (state.state === "healthy") return "Healthy";
  if (state.state === "degraded") return `Degraded · ${state.layer} ${state.reason}`;
  return `Down · ${state.layer}`;
}

export function stateTone(state: NetworkLinkState): Tone {
  return state.state === "healthy" ? "ok" : state.state === "degraded" ? "warn" : "fail";
}

/**
 * The status to show for a `/v1/network` response. `healthy` only means no episode is
 * open, so a response without any recent sample is shown as unknown instead.
 */
export function networkBadge(
  status: NetworkStatus | null | undefined,
  now: number,
): { label: string; tone: Tone } {
  const newest = Math.max(0, ...(status?.targets ?? []).map((target) => target.latest?.ts_ms ?? 0));
  if (!status || now - newest > NETWORK_STALE_MS) return { label: "Unknown", tone: "neutral" };
  return { label: stateLabel(status.state), tone: stateTone(status.state) };
}

export const mbps = (bps: number | null | undefined) =>
  bps == null ? "—" : number(bps / 1_000_000, "Mb/s");
export const usMs = (us: number | null | undefined) => (us == null ? "—" : number(us / 1000, "ms"));

/** One chart row per timestamp, with `latency<i>` and `loss<i>` for the i-th target. */
export function layerRows(series: NetworkSeries[]) {
  const rows = new Map<number, Record<string, number | null>>();
  series.forEach((target, index) => {
    for (const point of target.points) {
      const row = rows.get(point.ts_ms) ?? { ts_ms: point.ts_ms };
      row[`latency${index}`] = point.latency_ms.avg ?? null;
      row[`loss${index}`] = point.loss_percent;
      rows.set(point.ts_ms, row);
    }
  });
  return [...rows.values()].sort((a, b) => a.ts_ms! - b.ts_ms!);
}

/** Events of one layer that overlap [from, now], clipped to that window; open ones run to now. */
export function eventBands(events: NetworkEvent[], layer: string, from: number, now: number) {
  return events
    .filter((event) => event.state !== "healthy" && event.layer === layer)
    .filter((event) => event.started_ms <= now && (event.ended_ms ?? now) >= from)
    .map((event) => ({
      id: event.id,
      x1: Math.max(from, event.started_ms),
      x2: Math.min(now, event.ended_ms ?? now),
      tone: event.state === "down" ? ("fail" as const) : ("warn" as const),
    }));
}
