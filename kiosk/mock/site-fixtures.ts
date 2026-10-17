import type {
  DeviceHistory,
  DeviceList,
  DeviceRange,
  DeviceView,
  Endpoints,
  NetworkEvent,
  NetworkLinkState,
  NetworkRange,
  NetworkSample,
  NetworkSpeedTest,
  UpsCurrent,
  UpsRange,
} from "../src/api/types.ts";
import type { ControlState } from "../src/api/ups-control.ts";
import deviceSnapshot from "./device-view.json" with { type: "json" };

/** Window and bucket count per history range, shared by UPS and device history. */
const windows: Record<UpsRange, { span_ms: number; buckets: number }> = {
  "1h": { span_ms: 3_600_000, buckets: 60 },
  "24h": { span_ms: 86_400_000, buckets: 96 },
  "7d": { span_ms: 604_800_000, buckets: 168 },
  "30d": { span_ms: 2_592_000_000, buckets: 180 },
  "365d": { span_ms: 31_536_000_000, buckets: 365 },
};

const metric = (value: number, swing: number) => ({
  min: value - swing,
  avg: value,
  max: value + swing,
});

/** Shifts every `*_ms` timestamp in a captured snapshot so the view reads as freshly observed. */
function shift<T>(value: T, delta: number): T {
  if (Array.isArray(value)) return value.map((item) => shift(item, delta)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key.endsWith("_ms") && typeof item === "number" ? item + delta : shift(item, delta),
      ]),
    ) as T;
  return value;
}

/** UPS and device fixtures for the mock API; the device view is a captured sandbox snapshot. */
export function siteFixtures(
  outage = false,
  upsRange: UpsRange = "24h",
  deviceRange: DeviceRange = "1h",
  now = Date.now(),
) {
  const current: UpsCurrent | null = outage
    ? null
    : {
        ts_ms: now - 2_000,
        status: "OL",
        flags: ["OL"],
        on_line: true,
        on_battery: false,
        low_battery: false,
        replace_battery: false,
        charge_percent: 100,
        charge_low_percent: 30,
        charge_warning_percent: 20,
        runtime_s: 4_200,
        runtime_low_s: 300,
        load_percent: 24,
        load_w: 144,
        load_nominal_w: 600,
        input_v: 121,
        output_v: 120,
        battery_v: 25.9,
        test_result: "Done and passed",
        model: "CyberPower CP1500PFCLCD",
      };
  const ups: Endpoints["/v1/ups"] = {
    generated_at_ms: now,
    current,
    warnings: outage ? ["UPS collector offline since 14:02"] : [],
  };
  const upsWindow = windows[upsRange];
  const upsHistory: Endpoints["/v1/ups/history"] = outage
    ? []
    : Array.from({ length: upsWindow.buckets }, (_, index) => {
        const dip = index === Math.floor(upsWindow.buckets * 0.6);
        return {
          ts_ms: now - upsWindow.span_ms + (index * upsWindow.span_ms) / upsWindow.buckets,
          sample_count: 4,
          charge_percent: metric(dip ? 86 : 100, dip ? 6 : 0),
          load_w: metric(140 + Math.round(Math.sin(index / 5) * 30), 8),
          input_v: metric(dip ? 0 : 121 + Math.round(Math.sin(index / 7) * 2), 1),
          runtime_s: dip ? 3_300 : 4_200,
        };
      });
  const upsEvents: Endpoints["/v1/ups/events"] = {
    events: outage
      ? []
      : [
          {
            id: 2,
            kind: "on_battery",
            started_ms: now - 0.4 * upsWindow.span_ms,
            ended_ms: now - 0.4 * upsWindow.span_ms + 48_000,
            end_reason: "line_restored",
            min_charge_percent: 86,
            min_runtime_s: 3_300,
            detail: "Input dropped to 0 V",
          },
          {
            id: 1,
            kind: "self_test",
            started_ms: now - 6 * 86_400_000,
            ended_ms: now - 6 * 86_400_000 + 12_000,
            end_reason: "passed",
            min_charge_percent: null,
            min_runtime_s: null,
            detail: "Done and passed",
          },
        ],
    next_before_ms: null,
    next_before_id: null,
  };
  // Milliwatt-hours: a 144 W load over the window, with the GPU share at 121 W.
  const hours = upsWindow.span_ms / 3_600_000;
  const upsEnergy: Endpoints["/v1/ups/energy"] = {
    energy_mwh: Math.round(144 * hours * 1_000),
    gpu_energy_mwh: Math.round(121 * hours * 1_000),
    cost_nano_usd: Math.round(144 * hours * 180_000),
    electricity_rate_micro_usd_per_kwh: 180_000,
    coverage_percent: outage ? 0 : 98.4,
  };
  const upsSettings: Endpoints["/v1/settings/ups"] = {
    battery_installed_ms: now - 400 * 86_400_000,
    electricity_rate_micro_usd_per_kwh: 180_000,
  };
  const devices: DeviceList = {
    generated_at_ms: now,
    devices: [
      {
        device_id: "factory-gpu",
        health: outage ? "unknown" : "healthy",
        href: "/devices/factory-gpu",
      },
    ],
  };
  const snapshot = deviceSnapshot as DeviceView;
  const deviceView = shift(snapshot, now - snapshot.generated_at_ms - 5_000);
  const deviceWindow = windows[deviceRange];
  const deviceHistory: DeviceHistory = {
    device_id: "factory-gpu",
    range: deviceRange,
    generated_at_ms: now,
    points: outage
      ? []
      : Array.from({ length: deviceWindow.buckets }, (_, index) => ({
          ts_ms: now - deviceWindow.span_ms + (index * deviceWindow.span_ms) / deviceWindow.buckets,
          sample_count: 4,
          cpu_percent: metric(18 + Math.round(Math.sin(index / 6) * 12 + 12), 5),
          cpu_temp_c: metric(52 + Math.round(Math.sin(index / 9) * 6), 2),
          load1: metric(1.2 + Math.sin(index / 6) * 0.8, 0.3),
          memory_used_bytes: metric(21e9 + Math.round(Math.sin(index / 10) * 3e9), 4e8),
          disk_read_bps: metric(4e6 + (index % 7) * 1e6, 1e6),
          disk_write_bps: metric(9e5 + (index % 5) * 2e5, 2e5),
          net_rx_bps: metric(3e6 + Math.round(Math.sin(index / 4) * 2e6 + 2e6), 5e5),
          net_tx_bps: metric(8e5 + (index % 9) * 1e5, 1e5),
        })),
  };
  // Read-only in the mock: the server answers POST with 405, so no action can be confirmed.
  const control: ControlState = {
    login: "synthetic@github",
    actions: [
      {
        action: "test.quick",
        label: "Quick self-test",
        tier: "safe",
        confirm_phrase: "CONFIRM",
        enabled: true,
        disabled_reason: null,
      },
      {
        action: "beeper.mute",
        label: "Mute beeper",
        tier: "safe",
        confirm_phrase: "CONFIRM",
        enabled: true,
        disabled_reason: null,
      },
      {
        action: "input.sensitivity",
        label: "Input sensitivity",
        tier: "settings",
        confirm_phrase: "CONFIRM",
        enabled: true,
        disabled_reason: null,
      },
      {
        action: "ups.delay.start",
        label: "Startup delay",
        tier: "settings",
        confirm_phrase: "CONFIRM",
        enabled: true,
        disabled_reason: null,
      },
      {
        action: "power.cycle",
        label: "Power cycle outlets",
        tier: "power",
        confirm_phrase: "CONFIRM",
        enabled: true,
        disabled_reason: null,
      },
      {
        action: "power.off_stay",
        label: "Shut down and stay off",
        tier: "power",
        confirm_phrase: "CONFIRM",
        enabled: false,
        disabled_reason: "Final shutdown hook overrides stay-off",
      },
    ],
    settings: {
      "input.sensitivity": {
        value: "normal",
        allowed_values: ["low", "normal", "high"],
        ranges: [],
        range_source: "upsd",
      },
      "ups.delay.start": {
        value: "35",
        allowed_values: [],
        ranges: [
          [30, 40],
          [60, 90],
        ],
        range_source: "upsd",
      },
    },
    pending_power_action: null,
    audit: [
      {
        id: 2,
        ts_ms: now - 3 * 86_400_000,
        login: "synthetic@github",
        action: "test.quick",
        value: null,
        result: "ok",
      },
      {
        id: 1,
        ts_ms: now - 9 * 86_400_000,
        login: "synthetic@github",
        action: "input.sensitivity",
        value: "normal",
        result: "ok",
      },
    ],
  };
  return {
    ups,
    upsHistory,
    upsEvents,
    upsEnergy,
    upsSettings,
    devices,
    deviceView,
    deviceHistory,
    control,
  };
}

export type NetworkMode = "healthy" | "degraded" | "down";
const registry = [
  { layer: "lan", target: "gateway", address: "192.168.4.1", probe: "icmp", rtt_ms: 0.4 },
  { layer: "wan", target: "1.1.1.1", address: "1.1.1.1", probe: "icmp", rtt_ms: 9 },
  { layer: "wan", target: "8.8.8.8", address: "8.8.8.8", probe: "icmp", rtt_ms: 11 },
  { layer: "dns", target: "dns", address: "cloudflare.com", probe: "resolve", rtt_ms: 14 },
  {
    layer: "tailnet",
    target: "tailnet",
    address: "100.91.20.11:22",
    probe: "tcp_connect",
    rtt_ms: 4,
  },
] as const;

/**
 * Network fixtures for the mock API. `mode` picks the open episode on the wan layer; closed
 * episodes on every layer sit 6 h, 30 h and 5 d back. Outage means no sample has arrived yet.
 */
export function networkFixtures(
  mode: NetworkMode = "healthy",
  outage = false,
  range: NetworkRange = "24h",
  speedRange: Exclude<NetworkRange, "1h"> = "7d",
  now = Date.now(),
) {
  const episode = (
    id: number,
    link: Pick<NetworkEvent, "state"> & Partial<NetworkEvent>,
    started_ms: number,
    ended_ms: number | null,
  ) =>
    ({
      id,
      started_ms,
      ended_ms,
      end_reason: ended_ms == null ? null : "recovered",
      peak_loss_percent: link.state === "down" ? 100 : 0,
      peak_rtt_us: null,
      peak_mdev_us: null,
      ...link,
    }) as NetworkEvent;
  const link: NetworkLinkState =
    mode === "down"
      ? { state: "down", layer: "wan" }
      : mode === "degraded"
        ? { state: "degraded", layer: "wan", reason: "latency" }
        : { state: "healthy" };
  const open =
    link.state === "healthy"
      ? null
      : episode(
          4,
          { ...link, peak_rtt_us: link.state === "down" ? null : 241_000 },
          now - 180_000,
          null,
        );
  const closed = [
    episode(3, { state: "down", layer: "wan" }, now - 6 * 3_600_000, now - 6 * 3_600_000 + 300_000),
    episode(
      2,
      { state: "degraded", layer: "lan", reason: "loss", peak_loss_percent: 30 },
      now - 30 * 3_600_000,
      now - 30 * 3_600_000 + 1_200_000,
    ),
    {
      ...episode(
        1,
        {
          state: "degraded",
          layer: "dns",
          reason: "latency",
          peak_rtt_us: 312_000,
          peak_mdev_us: 48_000,
        },
        now - 5 * 86_400_000,
        now - 5 * 86_400_000 + 3_600_000,
      ),
      end_reason: "restart",
    } as NetworkEvent,
  ];
  const events = outage ? [] : [...(open ? [open] : []), ...closed];
  const during = (ts_ms: number, layer: string) =>
    events.find(
      (event) =>
        event.state !== "healthy" &&
        event.layer === layer &&
        event.started_ms <= ts_ms &&
        ts_ms <= (event.ended_ms ?? now),
    );
  const reading = (entry: (typeof registry)[number], ts_ms: number, index: number) => {
    const event = during(ts_ms, entry.layer);
    const rtt_ms = entry.rtt_ms * (1 + 0.15 * Math.sin(index / 4 + entry.rtt_ms));
    if (event?.state === "down") return { loss: 100, rtt_ms: null };
    if (event?.state === "degraded" && event.reason === "loss") return { loss: 30, rtt_ms };
    if (event?.state === "degraded") return { loss: 0, rtt_ms: (event.peak_rtt_us ?? 0) / 1000 };
    return { loss: index % 41 === 19 ? 10 : 0, rtt_ms };
  };
  const tick = now - 4_000;
  const status: Endpoints["/v1/network"] = {
    generated_at_ms: now,
    device_id: "factory-gpu",
    state: outage ? { state: "healthy" } : link,
    open_event: open,
    targets: registry.map((entry) => {
      const { loss, rtt_ms } = reading(entry, tick, -1);
      const received = 10 - loss / 10;
      const latest: NetworkSample = {
        ts_ms: tick,
        layer: entry.layer,
        target: entry.target,
        address: entry.address,
        sent: 10,
        received,
        rtt:
          rtt_ms == null
            ? null
            : {
                min_us: Math.round(rtt_ms * 800),
                avg_us: Math.round(rtt_ms * 1000),
                max_us: Math.round(rtt_ms * 1300),
                mdev_us: Math.round(rtt_ms * 90),
              },
      };
      return {
        layer: entry.layer,
        target: entry.target,
        probe: entry.probe,
        latest: outage ? null : latest,
      };
    }),
    latest_speed_test: null,
    warnings: outage ? ["network: ping: connect: Network is unreachable"] : [],
  };
  const window = windows[range];
  const history: Endpoints["/v1/network/history"] = {
    range,
    resolution: range === "1h" || range === "24h" ? "raw" : "hourly",
    series: outage
      ? []
      : registry.map((entry) => ({
          layer: entry.layer,
          target: entry.target,
          points: Array.from({ length: window.buckets }, (_, index) => {
            const ts_ms = Math.round(
              now - window.span_ms + ((index + 1) * window.span_ms) / window.buckets,
            );
            const { loss, rtt_ms } = reading(entry, ts_ms, index);
            return {
              ts_ms,
              sample_count: 4,
              loss_percent: loss,
              latency_ms:
                rtt_ms == null
                  ? { min: null, avg: null, max: null }
                  : { min: rtt_ms * 0.8, avg: rtt_ms, max: rtt_ms * 1.3 },
              jitter_ms: rtt_ms == null ? null : rtt_ms * 0.09,
            };
          }),
        })),
  };
  const count = outage ? 0 : Math.floor(windows[speedRange].span_ms / 10_800_000);
  const tests: NetworkSpeedTest[] = Array.from({ length: count }, (_, index) => {
    const started_ms = now - (count - index) * 10_800_000 + 600_000;
    const failed = index % 9 === 4;
    const timeout = index % 13 === 7;
    const ok = !failed && !timeout;
    return {
      id: 1_000 + index,
      started_ms,
      ended_ms: started_ms + (timeout ? 60_000 : ok ? 11_000 : 400),
      outcome: failed ? "failed" : timeout ? "timeout" : "ok",
      download_bps: ok ? Math.round(930e6 + 12e6 * Math.sin(index)) : null,
      upload_bps: ok ? Math.round(912e6 + 9e6 * Math.cos(index)) : null,
      download_bytes: ok ? 440_000_000 : timeout ? 25_000_000 : 0,
      upload_bytes: ok ? 290_000_000 : 0,
      idle_latency_ms: ok || timeout ? 9.1 : null,
      download_loaded_latency_ms: ok ? 14 + (index % 5) : null,
      upload_loaded_latency_ms: ok ? 19 + (index % 3) : null,
      colo: ok || timeout ? "IAD" : null,
      error: failed ? "HTTP 500 from speed endpoint" : timeout ? "test exceeded 60 s" : null,
    };
  });
  status.latest_speed_test = tests.at(-1) ?? null;
  const speedTests: Endpoints["/v1/network/speed-tests"] = { range: speedRange, tests };
  return { status, history, speedTests, events };
}
