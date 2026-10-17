import type { DeviceHistory, Metric } from "../api/types";
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
