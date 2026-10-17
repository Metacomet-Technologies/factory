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

type HealthStatus = DeviceView["device"]["health"]["status"];

/** devices.rs: slow inventory is stale once older than twice its 300 s interval. */
export const SLOW_STALE_MS = 600_000;

const RANK: Record<HealthStatus, number> = {
  critical: 4,
  warning: 3,
  stale: 2,
  unknown: 1,
  healthy: 0,
};

/** Reasons `assess_within` derives from freshness and presence; recomputed here as of `now`. */
const DERIVED = new Set([
  "collector.fast",
  "ingest.transport",
  "cpu.utilization",
  "memory.total",
  "filesystem.size",
]);

/**
 * A remote view as of `now`, following factory-api's `freshen_within` for remote
 * devices: fast readings expire after 45 s of collection or transport age, CPU
 * temperature and filesystems after slow inventory is older than 600000 ms, and health
 * is reassessed from the remaining reasons. Critical and warning findings whose
 * readings are still valid (SMART, spare, media, or fresh slow values) are kept, so a
 * cached frame (for example a push while GETs fail) never shows expired readings as
 * current and never hides a server finding. Transport state stays in `linkState`.
 */
export function freshenRemote(view: DeviceView, now: number): DeviceView {
  if (linkState(view, now) === "waiting") return view;
  const host = view.device;
  const received = view.ingest?.last_received_at_ms;
  const quiet = received != null && now - received > REMOTE_STALE_MS ? now - received : null;
  const fastStale = now - host.observed_at_ms > REMOTE_STALE_MS || quiet != null;
  const lastSlow = host.collector.last_slow_ms;
  const slowStale = lastSlow == null || now - lastSlow > SLOW_STALE_MS;
  if (!fastStale && !slowStale) return view;
  const expire =
    (detail: string) =>
    (metric: Metric): Metric =>
      metric.availability === "available"
        ? { ...metric, value: null, availability: "stale", detail }
        : metric;
  let { cpu, memory, disk_io, network, filesystems } = host;
  if (fastStale) {
    const fast = expire(`last sample at ${host.observed_at_ms}`);
    cpu = {
      ...cpu,
      utilization: fast(cpu.utilization),
      iowait: fast(cpu.iowait),
      load1: fast(cpu.load1),
      load5: fast(cpu.load5),
      load15: fast(cpu.load15),
    };
    memory = {
      ...memory,
      total: fast(memory.total),
      available: fast(memory.available),
      used: fast(memory.used),
    };
    disk_io = { read: fast(disk_io.read), write: fast(disk_io.write) };
    network = { rx: fast(network.rx), tx: fast(network.tx) };
  }
  if (slowStale) {
    const slow = expire("slow inventory is older than twice its interval");
    cpu = { ...cpu, temperature: slow(cpu.temperature) };
    filesystems = filesystems.map((fs) => ({
      ...fs,
      size: slow(fs.size),
      used: slow(fs.used),
      used_percent: slow(fs.used_percent),
      inodes_used_percent: slow(fs.inodes_used_percent),
    }));
  }
  // Findings from expired slow readings go; everything else the server found stays.
  const reasons = host.health.reasons.filter(
    (reason) =>
      !DERIVED.has(reason.metric) &&
      !(
        slowStale &&
        (reason.metric === "cpu.temperature" || reason.metric.startsWith("filesystem."))
      ),
  );
  const add = (
    status: HealthStatus,
    metric: string,
    threshold: string,
    value: number | null,
    detail: string,
  ) => reasons.push({ status, metric, threshold, value, detail });
  const lastFast = host.collector.last_fast_ms;
  if (!host.collector.fast_ok || (lastFast != null && now - lastFast > REMOTE_STALE_MS))
    add(
      "stale",
      "collector.fast",
      "45 s",
      lastFast == null ? null : now - lastFast,
      host.collector.fast_ok ? "latest fast sample is older than 45 s" : "device collector failed",
    );
  if (cpu.utilization.availability !== "available")
    add(
      "unknown",
      "cpu.utilization",
      "present",
      null,
      cpu.utilization.detail ?? "CPU utilization is missing",
    );
  if (memory.total.availability !== "available")
    add("unknown", "memory.total", "present", null, "memory total is missing");
  if (!filesystems.some((fs) => fs.size.availability === "available"))
    add("unknown", "filesystem.size", "present", null, "filesystem capacity is missing");
  if (quiet != null)
    add(
      "stale",
      "ingest.transport",
      "45 s",
      quiet,
      `no sample received for ${Math.floor(quiet / 1000)} s`,
    );
  reasons.sort((a, b) => RANK[b.status] - RANK[a.status] || a.metric.localeCompare(b.metric));
  return {
    ...view,
    device: {
      ...host,
      cpu,
      memory,
      disk_io,
      network,
      filesystems,
      health: { status: reasons[0]?.status ?? "healthy", reasons },
    },
  };
}

export const DEVICE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
