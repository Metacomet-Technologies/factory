import type { DeviceHistory, Metric } from "../api/types";
import { number } from "./format";

export function metricText(metric: Metric | undefined) {
  if (metric?.value == null) return "—";
  return number(metric.value, metric.unit);
}

export function chartPoints(points: DeviceHistory["points"]) {
  return points.map((point) => ({
    ts_ms: point.ts_ms,
    cpu: point.cpu_percent.avg,
    memory: point.memory_used_bytes.avg,
    temp: point.cpu_temp_c.avg,
  }));
}
