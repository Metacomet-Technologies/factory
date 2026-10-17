import type {
  DeviceHistory,
  DeviceList,
  DeviceRange,
  DeviceView,
  Endpoints,
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
