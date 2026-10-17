import type { DeviceHistory, DeviceView, Metric } from "../api/types";
import { ms, number } from "./format";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** Human-readable metric: bytes become GiB/MiB, rates MB/s, seconds a duration; null is an em dash, never 0. */
export function metricText(metric: Metric | undefined) {
  if (metric?.value == null) return "—";
  const { value, unit } = metric;
  switch (unit) {
    case "bytes":
      return value >= GIB ? number(value / GIB, "GiB") : number(value / MIB, "MiB");
    case "B/s":
      return value >= 1e6 ? number(value / 1e6, "MB/s") : number(value / 1e3, "kB/s");
    case "s":
      return ms(value * 1000);
    case "load":
    case "count":
    case "metric":
      return number(value);
    default:
      return number(value, unit);
  }
}

export function chartPoints(points: DeviceHistory["points"]) {
  return points.map((point) => ({
    ts_ms: point.ts_ms,
    cpu: point.cpu_percent.avg,
    memory: point.memory_used_bytes.avg,
    temp: point.cpu_temp_c.avg,
  }));
}

/** Server thresholds for remote devices: stale after 45 s; 2 min matches the telemetry alert. */
export const REMOTE_STALE_MS = 45_000;
export const REMOTE_OFFLINE_MS = 120_000;
export const WAITING_FOR_FIRST_SAMPLE = "waiting for first sample";

export type LinkState = "waiting" | "live" | "stale" | "offline";

/**
 * Agent link for a remote device, recomputed every second from the server's receive time
 * (transport age) and the sample's own time (collection age). A live link says nothing
 * about whether each metric is healthy.
 */
export function linkState(view: DeviceView, now: number): LinkState {
  const received = view.ingest?.last_received_at_ms;
  if (received == null || view.warnings.includes(WAITING_FOR_FIRST_SAMPLE)) return "waiting";
  const transport = now - received;
  if (transport > REMOTE_OFFLINE_MS) return "offline";
  if (transport > REMOTE_STALE_MS || now - view.device.observed_at_ms > REMOTE_STALE_MS)
    return "stale";
  return "live";
}

export const DEVICE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
