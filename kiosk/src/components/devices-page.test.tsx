import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import App from "../App";
import DevicesPage from "./devices-page";
import { chartPoints, metricText } from "../lib/devices";
import { initialLiveState, parseEvent, streamReducer } from "../api/stream";
import type { DeviceHistory, DeviceView, Metric } from "../api/types";
import { fixtures } from "../../mock/fixtures";

const metric = (
  value: number | null,
  unit = "%",
  availability = value == null ? "error" : "available",
): Metric => ({ value, unit, observed_at_ms: 1_000, availability, detail: null }) as Metric;

function view(): DeviceView {
  return {
    generated_at_ms: 1_000,
    warnings: [],
    device: {
      device_id: "factory-gpu",
      observed_at_ms: 1_000,
      identity: { hostname: "factory-gpu", boot_id: "boot", uptime: metric(1000, "s") },
      cpu: {
        utilization: metric(null),
        iowait: metric(null),
        load1: metric(0.2, ""),
        load5: metric(0.2, ""),
        load15: metric(0.2, ""),
        temperature: metric(96, "C"),
      },
      memory: {
        total: metric(null, "B"),
        available: metric(null, "B"),
        used: metric(null, "B"),
        swap_total: metric(0, "B"),
        swap_free: metric(0, "B"),
      },
      gpus: [],
      filesystems: [],
      drives: [
        {
          id: "wwn-abc",
          kernel: "nvme0n1",
          model: null,
          size: metric(null, "B"),
          smart: { availability: "unsupported", passed: null, observed_at_ms: 1_000, detail: null },
          available_spare: metric(null),
          spare_threshold_percent: null,
          media_errors: metric(null),
          media_critical: false,
          temperature: metric(null, "C"),
        },
      ],
      disk_io: { read: metric(null, "B/s"), write: metric(null, "B/s") },
      network: { rx: metric(null, "B/s"), tx: metric(null, "B/s") },
      cooling: {
        temperatures: [],
        fans: [],
        temperatures_availability: "unsupported",
        fans_availability: "unsupported",
      },
      maintenance: {
        services: [],
        backup: {
          availability: "available",
          last_success_ms: null,
          last_attempt_ms: null,
          error: null,
          observed_at_ms: 1_000,
        },
        clock: { synchronized: true, availability: "available", observed_at_ms: 1_000 },
        reboot: {
          availability: "permission_denied",
          reboot_required: null,
          pending_since_ms: null,
          days_pending: null,
          consecutive_skips: null,
          alert_due: null,
          last_check_ms: null,
          last_decision: null,
          detail: null,
        },
        ups: {
          href: "/ups",
          availability: "error",
          status: null,
          charge_percent: null,
          observed_at_ms: 1_000,
          detail: null,
        },
      },
      collector: {
        fast_interval_ms: 15_000,
        slow_interval_ms: 300_000,
        last_fast_ms: 1_000,
        last_slow_ms: 1_000,
        fast_ok: true,
        filesystems: "available",
        drives: "available",
        smart: "unsupported",
        detail: null,
      },
      health: {
        status: "critical",
        reasons: [
          {
            status: "critical",
            metric: "cpu.temperature",
            threshold: "95 C",
            value: 96,
            detail: "above 95 C",
          },
        ],
      },
    },
  } as DeviceView;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  document.documentElement.dataset.theme = "dark";
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "EventSource",
    class extends EventTarget {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((message: MessageEvent<string>) => void) | null = null;
      close() {}
    },
  );
});

describe("devices page", () => {
  it("renders health reasons and an em dash for unknown readings", () => {
    expect(metricText(metric(null))).toBe("—");
    expect(metricText(metric(null))).not.toBe("0");
    render(
      <DevicesPage
        view={view()}
        history={{ device_id: "factory-gpu", range: "1h", generated_at_ms: 1_000, points: [] }}
        range="1h"
        setRange={() => {}}
        error={null}
        loading={false}
        connected
        live
        now={2_000}
      />,
    );
    expect(screen.getByText("critical")).toBeInTheDocument();
    expect(screen.getByText(/cpu.temperature 95 C/)).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText("0 %")).not.toBeInTheDocument();
    expect(screen.getByText(/Unsupported SMART is not evidence/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "UPS" })).toHaveAttribute("href", "/ups");
    expect(screen.getByText(/Reboot permission denied/)).toBeInTheDocument();
  });

  it("keeps chart gaps null instead of zero", () => {
    const history = {
      points: [
        {
          ts_ms: 0,
          sample_count: 1,
          cpu_percent: { min: null, avg: null, max: null },
          memory_used_bytes: { min: null, avg: null, max: null },
          load1: { min: null, avg: null, max: null },
          disk_read_bps: { min: null, avg: null, max: null },
          disk_write_bps: { min: null, avg: null, max: null },
          net_rx_bps: { min: null, avg: null, max: null },
          net_tx_bps: { min: null, avg: null, max: null },
          cpu_temp_c: { min: null, avg: null, max: null },
        },
        {
          ts_ms: 7_200_000,
          sample_count: 1,
          cpu_percent: { min: 10, avg: 12, max: 14 },
          memory_used_bytes: { min: null, avg: null, max: null },
          load1: { min: null, avg: null, max: null },
          disk_read_bps: { min: null, avg: null, max: null },
          disk_write_bps: { min: null, avg: null, max: null },
          net_rx_bps: { min: null, avg: null, max: null },
          net_tx_bps: { min: null, avg: null, max: null },
          cpu_temp_c: { min: null, avg: null, max: null },
        },
      ],
    } as DeviceHistory;
    const points = chartPoints(history.points);
    expect(points).toHaveLength(2);
    expect(points[0]?.cpu).toBeNull();
    expect(points[1]?.cpu).toBe(12);
    expect(points.some((point) => point.cpu === 0)).toBe(false);
  });

  it("drops the live sample on disconnect and follows real links", async () => {
    const sample = parseEvent({
      type: "devices.sample",
      ts_ms: 5,
      data: view(),
    });
    expect(sample?.type).toBe("devices.sample");
    const live = streamReducer(initialLiveState, sample!);
    expect(live.devices?.device.health.status).toBe("critical");
    const dropped = streamReducer(live, { type: "devices.sample", ts_ms: 6, data: null });
    expect(dropped.devices).toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => {
        const url = new URL(path, "http://localhost");
        const data = fixtures();
        const routes: Record<string, unknown> = {
          "/v1/health": data.health,
          "/v1/fleet": data.fleet,
          "/v1/llm/usage": data.usage,
          "/v1/gpu": data.gpu,
          "/v1/ups": { generated_at_ms: 1, current: null, warnings: [] },
          "/v1/pricing": data.pricing,
          "/v1/agents": data.agents,
          "/v1/devices": {
            generated_at_ms: 1,
            devices: [
              { device_id: "factory-gpu", health: "unknown", href: "/devices/factory-gpu" },
            ],
          },
          "/v1/devices/factory-gpu": view(),
          "/v1/devices/factory-gpu/history": {
            device_id: "factory-gpu",
            range: "1h",
            generated_at_ms: 1,
            points: [],
          },
        };
        return Promise.resolve(new Response(JSON.stringify(routes[url.pathname] ?? null)));
      }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Devices" }));
    expect(window.location.pathname).toBe("/devices");
    expect(await screen.findByRole("heading", { name: "Devices" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: /factory-gpu/ }));
    expect(window.location.pathname).toBe("/devices/factory-gpu");
    expect(await screen.findByRole("heading", { name: "Host health" })).toBeInTheDocument();
    act(() => {
      window.history.back();
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(window.location.pathname).toBe("/devices"));
    expect(screen.getByRole("heading", { name: "Devices" })).toBeInTheDocument();
  });
});
