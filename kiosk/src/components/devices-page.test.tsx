import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";
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

/** factory-console as factory-api serves it: no GPU, UPS unsupported, ingest state present. */
function remoteView(
  observed: number,
  received = observed + 150,
  slowAt = observed - 60_000,
): DeviceView {
  const data = view();
  const at = (m: Metric) => ({ ...m, observed_at_ms: observed });
  const slow = (m: Metric) => ({ ...m, observed_at_ms: slowAt });
  data.generated_at_ms = received;
  data.device.device_id = "factory-console";
  data.device.identity.hostname = "factory-console";
  data.device.observed_at_ms = observed;
  data.device.cpu.utilization = at(metric(12.5));
  data.device.cpu.temperature = {
    ...at(metric(null, "C", "unsupported")),
    detail: "no CPU temperature sensor",
  };
  data.device.memory.total = at(metric(17179869184, "bytes"));
  data.device.memory.used = at(metric(5368709120, "bytes"));
  data.device.maintenance.ups = {
    href: "/ups",
    availability: "unsupported",
    status: null,
    charge_percent: null,
    observed_at_ms: observed,
    detail: "UPS is reported only for factory-gpu",
  };
  data.device.filesystems = [
    {
      id: "/dev/nvme0n1p2\t/",
      mountpoint: "/",
      source: "/dev/nvme0n1p2",
      fstype: "ext4",
      size: slow(metric(245_107_195_904, "bytes")),
      used: slow(metric(220_596_476_314, "bytes")),
      used_percent: slow(metric(90)),
      inodes_used_percent: slow(metric(4.1)),
    },
  ];
  data.device.collector.last_fast_ms = observed;
  data.device.collector.last_slow_ms = slowAt;
  // As factory-api assesses this frame: one warning, from the filesystem.
  data.device.health = {
    status: "warning",
    reasons: [
      {
        status: "warning",
        metric: "filesystem./dev/nvme0n1p2\t/",
        threshold: "85%",
        value: 90,
        detail: "/ space 90.0%",
      },
    ],
  };
  data.ingest = {
    source: "remote",
    last_received_at_ms: received,
    session_id: "6f1c2a9e-3b4d-4e8f-9a01-2c3d4e5f6a7b",
    seq: 42,
    agent_version: "0.1.0",
    clock_skew_ms: -180,
    dropped_samples: 0,
    identity_conflict: false,
  };
  return data;
}

function failSmart(data: DeviceView): DeviceView {
  const drive = data.device.drives[0]!;
  drive.smart = {
    availability: "available",
    passed: false,
    observed_at_ms: data.device.collector.last_slow_ms!,
    detail: null,
  };
  data.device.health = {
    status: "critical",
    reasons: [
      {
        status: "critical",
        metric: `drive.${drive.id}.smart`,
        threshold: "passed",
        value: null,
        detail: `${drive.kernel} SMART failed`,
      },
      ...data.device.health.reasons,
    ],
  };
  return data;
}

function remotePage(data: DeviceView | null, now: number) {
  return (
    <DevicesPage
      deviceId="factory-console"
      view={data}
      history={null}
      range="1h"
      setRange={() => {}}
      error={null}
      loading={false}
      connected
      live
      now={now}
    />
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
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

describe("remote devices", () => {
  it("shows link freshness, stale, offline and recovery from receive and observe times", () => {
    const t = 1_792_238_415_000;
    const { rerender } = render(remotePage(remoteView(t), t + 10_000));
    const link = within(screen.getByRole("region", { name: "Agent link" }));
    expect(link.getByText("Live")).toBeInTheDocument();
    expect(link.getByText("Received 9.9 s ago")).toBeInTheDocument();
    expect(link.getByText("Observed 10 s ago")).toBeInTheDocument();
    expect(link.getByText("6f1c2a9e · seq 42")).toBeInTheDocument();
    expect(link.getByText("−180 ms")).toBeInTheDocument();
    expect(link.getByText(/does not prove every metric is healthy/)).toBeInTheDocument();
    const summary = within(screen.getByRole("region", { name: "Host summary" }));
    expect(summary.getByText("warning")).toBeInTheDocument();
    // Collection age past 45 s: the link is stale and fast readings expire, but the
    // filesystem warning (slow inventory still fresh) stays, as factory-api reassesses.
    rerender(remotePage(remoteView(t), t + 45_500));
    expect(link.getByText("Stale")).toBeInTheDocument();
    expect(summary.getByText("warning")).toBeInTheDocument();
    expect(summary.getByText(/latest fast sample is older than 45 s/)).toBeInTheDocument();
    expect(summary.queryByText("12.5 %")).not.toBeInTheDocument();
    rerender(remotePage(remoteView(t), t + 121_000));
    expect(link.getByText("Offline")).toBeInTheDocument();
    expect(summary.getByText("warning")).toBeInTheDocument();
    expect(summary.getByText(/no sample received for 120 s/)).toBeInTheDocument();
    rerender(remotePage(remoteView(t + 125_000), t + 126_000));
    expect(link.getByText("Live")).toBeInTheDocument();
    expect(link.getByText("Recovered 0 ms ago.")).toBeInTheDocument();
    // A backward device clock shows up as collection age, not transport age.
    rerender(remotePage(remoteView(t + 60_000, t + 126_500), t + 127_000));
    expect(link.getByText("Stale")).toBeInTheDocument();
    expect(link.queryByText(/Recovered/)).not.toBeInTheDocument();
  });

  it("shows waiting, capability limits and no UPS or GPU claims", () => {
    const t = 1_792_238_415_000;
    const waiting = remoteView(t);
    waiting.warnings = ["waiting for first sample"];
    waiting.ingest = { ...waiting.ingest!, last_received_at_ms: null, session_id: null, seq: null };
    const { rerender } = render(remotePage(waiting, t + 1_000));
    const link = within(screen.getByRole("region", { name: "Agent link" }));
    expect(link.getByText("Waiting for first sample")).toBeInTheDocument();
    expect(link.getByText("No sample since factory-api started")).toBeInTheDocument();

    const limited = remoteView(t);
    limited.ingest = { ...limited.ingest!, identity_conflict: true, dropped_samples: 3 };
    limited.warnings = [
      "identity conflict: sessions from factory-console and imposter share this credential; revoke and reissue it",
    ];
    rerender(remotePage(limited, t + 1_000));
    expect(screen.getByText("factory-console", { selector: "p" })).toBeInTheDocument();
    expect(link.getByRole("alert")).toHaveTextContent("Identity conflict");
    expect(link.getByText(/sessions from factory-console and imposter/)).toBeInTheDocument();
    expect(link.getByText("3")).toBeInTheDocument();
    expect(link.getByText(/SMART unsupported · fans unsupported/)).toBeInTheDocument();
    expect(screen.getAllByText("unsupported").length).toBeGreaterThan(0);
    expect(screen.getByText(/Reboot permission denied/)).toBeInTheDocument();
    expect(screen.getByText(/Unsupported SMART is not evidence/)).toBeInTheDocument();
    expect(screen.getByText(/UPS is reported only for factory-gpu/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "UPS" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Maintenance snapshot/)).not.toBeInTheDocument();
    expect(screen.queryByText(/GPU 0/)).not.toBeInTheDocument();
  });

  it.each(["failed", "successful"] as const)(
    "ages a remote frame to stale and offline with %s GETs, keeps failed SMART critical, then recovers",
    async (gets) => {
      const t = 1_792_238_415_000;
      let clock = t + 1_000;
      vi.spyOn(Date, "now").mockImplementation(() => clock);
      let source: (EventTarget & Record<string, unknown>) | undefined;
      vi.stubGlobal(
        "EventSource",
        class extends EventTarget {
          onopen: (() => void) | null = null;
          onerror: (() => void) | null = null;
          onmessage: ((message: MessageEvent<string>) => void) | null = null;
          readyState = 1;
          constructor() {
            super();
            source = this as unknown as EventTarget & Record<string, unknown>;
          }
          close() {}
        },
      );
      const push = (frame: DeviceView) =>
        act(() => {
          (source!.onmessage as (message: MessageEvent<string>) => void)(
            new MessageEvent("message", {
              data: JSON.stringify({ type: "devices.sample", ts_ms: clock, data: frame }),
            }),
          );
        });
      const frame = failSmart(remoteView(t));
      frame.device.memory.used = { ...frame.device.memory.used, value: 5_368_709_120 };
      // Either every device GET fails and only the stream delivers the frame, or the
      // current-view GET serves it and no push arrives until recovery.
      let served = frame;
      vi.stubGlobal(
        "fetch",
        vi.fn((path: string) => {
          const url = new URL(path, "http://localhost");
          if (gets === "failed" && url.pathname.startsWith("/v1/devices"))
            return Promise.resolve(new Response("{}", { status: 503 }));
          const data = fixtures();
          const routes: Record<string, unknown> = {
            "/v1/health": data.health,
            "/v1/fleet": data.fleet,
            "/v1/llm/usage": data.usage,
            "/v1/gpu": data.gpu,
            "/v1/ups": { generated_at_ms: 1, current: null, warnings: [] },
            "/v1/pricing": data.pricing,
            "/v1/agents": data.agents,
            "/v1/devices": { generated_at_ms: 1, devices: [] },
            "/v1/devices/factory-console": served,
            "/v1/devices/factory-console/history": {
              device_id: "factory-console",
              range: "1h",
              generated_at_ms: 1,
              points: [],
            },
          };
          return Promise.resolve(new Response(JSON.stringify(routes[url.pathname] ?? null)));
        }),
      );
      window.history.replaceState(null, "", "/devices/factory-console");
      render(<App />);
      await waitFor(() => expect(source).toBeDefined());
      act(() => (source!.onopen as () => void)());
      if (gets === "failed") push(frame);
      const link = within(await screen.findByRole("region", { name: "Agent link" }));
      const summary = screen.getByRole("region", { name: "Host summary" });
      expect(link.getByText("Live")).toBeInTheDocument();
      expect(summary).toHaveTextContent("Host summary · Live");
      expect(within(summary).getByText("critical")).toBeInTheDocument();
      if (gets === "failed") expect(screen.getByText("HTTP 503")).toBeInTheDocument();

      // The agent stops. At 46 s the cached frame is stale, not Live, with no current readings.
      clock = t + 46_000;
      expect(await link.findByText("Stale", {}, { timeout: 2_000 })).toBeInTheDocument();
      expect(summary).toHaveTextContent("Host summary · Stored");
      expect(summary).not.toHaveTextContent("12.5");
      expect(summary).not.toHaveTextContent("5 GiB");
      expect(within(summary).getAllByText("stale").length).toBeGreaterThanOrEqual(3);
      // Transport stays in the Agent link; the server's SMART finding stays critical.
      expect(within(summary).getByText("critical")).toBeInTheDocument();
      expect(within(summary).getByText(/nvme0n1 SMART failed/)).toBeInTheDocument();

      clock = t + 121_000;
      expect(await link.findByText("Offline", {}, { timeout: 2_000 })).toBeInTheDocument();
      expect(summary).toHaveTextContent("Host summary · Stored");
      expect(summary).not.toHaveTextContent("12.5");
      expect(within(summary).getByText("critical")).toBeInTheDocument();

      // A fresh push recovers the page.
      clock = t + 130_000;
      const fresh = failSmart(remoteView(t + 129_500, t + 129_800));
      fresh.ingest = { ...fresh.ingest!, seq: 43 };
      served = fresh;
      push(fresh);
      expect(await link.findByText("Live", {}, { timeout: 2_000 })).toBeInTheDocument();
      expect(link.getByText(/^Recovered/)).toBeInTheDocument();
      expect(link.getByText("6f1c2a9e · seq 43")).toBeInTheDocument();
      expect(summary).toHaveTextContent("Host summary · Live");
      expect(within(summary).queryAllByText("stale")).toHaveLength(0);
      expect(summary).toHaveTextContent("12.5");
      expect(within(summary).getByText("critical")).toBeInTheDocument();
    },
  );

  it("expires CPU temperature and filesystems after exactly 600000 ms of slow age, then recovers", () => {
    const t = 1_792_238_415_000;
    // Fast pushes keep arriving; only the slow inventory is old.
    const aging = (now: number, slowAt: number) => {
      const data = remoteView(now - 1_000, now - 900, slowAt);
      data.device.cpu.temperature = {
        ...metric(82, "C"),
        observed_at_ms: slowAt,
      };
      data.device.health.reasons.push({
        status: "warning",
        metric: "cpu.temperature",
        threshold: "80 C",
        value: 82,
        detail: "CPU temperature 82.0 C",
      });
      return remotePage(data, now);
    };
    const { rerender } = render(aging(t, t - 600_000));
    const link = within(screen.getByRole("region", { name: "Agent link" }));
    const summary = within(screen.getByRole("region", { name: "Host summary" }));
    const filesystems = within(screen.getByRole("region", { name: "Filesystems" }));
    // At exactly 600000 ms the slow values are still available.
    expect(summary.getByText("82 C")).toBeInTheDocument();
    expect(filesystems.getByText(/205\.4 GiB of 228\.3 GiB · inodes 4\.1 %/)).toBeInTheDocument();
    expect(summary.getByText("warning")).toBeInTheDocument();
    expect(link.getByText("Live")).toBeInTheDocument();

    // One millisecond later they expire, and so do the warnings they carried.
    rerender(aging(t + 1, t - 600_000));
    expect(summary.queryByText("82 C")).not.toBeInTheDocument();
    expect(summary.getAllByText("stale")).toHaveLength(1);
    expect(filesystems.getByText("— of — · inodes —")).toBeInTheDocument();
    expect(summary.getByText("unknown")).toBeInTheDocument();
    expect(summary.getByText(/filesystem capacity is missing/)).toBeInTheDocument();
    expect(summary.queryByText(/space 90/)).not.toBeInTheDocument();
    expect(link.getByText("Live")).toBeInTheDocument();
    expect(summary.getByText("12.5 %")).toBeInTheDocument();

    // A fresh slow inventory brings the readings and the warning back.
    rerender(aging(t + 20_000, t + 19_000));
    expect(summary.getByText("82 C")).toBeInTheDocument();
    expect(filesystems.getByText(/205\.4 GiB of 228\.3 GiB/)).toBeInTheDocument();
    expect(summary.getByText("warning")).toBeInTheDocument();
  });

  it("keeps remote pushes apart from factory-gpu and routes both device pages", async () => {
    const console = remoteView(Date.now() - 2_000);
    const pushed = streamReducer(
      initialLiveState,
      parseEvent({ type: "devices.sample", ts_ms: 5, data: console })!,
    );
    expect(pushed.devices).toBeUndefined();
    expect(pushed.remoteDevices["factory-console"]?.ingest?.seq).toBe(42);
    expect(pushed.devicesRevision).toBe(1);
    const gpu = streamReducer(pushed, { type: "devices.sample", ts_ms: 6, data: view() });
    expect(gpu.devices?.device.device_id).toBe("factory-gpu");
    const failed = streamReducer(gpu, { type: "devices.sample", ts_ms: 7, data: null });
    expect(failed.devices).toBeNull();
    expect(failed.remoteDevices["factory-console"]).toBeDefined();
    const bad = { ...console, device: { ...console.device, device_id: "Bad_Id" } };
    expect(parseEvent({ type: "devices.sample", ts_ms: 8, data: bad })).toBeNull();

    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => {
        const url = new URL(path, "http://localhost");
        requested.push(url.pathname);
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
              { device_id: "factory-gpu", health: "critical", href: "/devices/factory-gpu" },
              { device_id: "factory-console", health: "warning", href: "/devices/factory-console" },
            ],
          },
          "/v1/devices/factory-gpu": view(),
          "/v1/devices/factory-console": console,
          "/v1/devices/factory-gpu/history": {
            device_id: "factory-gpu",
            range: "1h",
            generated_at_ms: 1,
            points: [],
          },
          "/v1/devices/factory-console/history": {
            device_id: "factory-console",
            range: "1h",
            generated_at_ms: 1,
            points: [],
          },
        };
        return Promise.resolve(new Response(JSON.stringify(routes[url.pathname] ?? null)));
      }),
    );
    render(<App />);
    const fleet = await screen.findByRole("region", { name: "Fleet" });
    expect(await within(fleet).findAllByRole("link")).toHaveLength(2);
    fireEvent.click(within(fleet).getByRole("link", { name: /factory-console/ }));
    expect(window.location.pathname).toBe("/devices/factory-console");
    expect(await screen.findByRole("region", { name: "Agent link" })).toBeInTheDocument();
    expect(requested).toContain("/v1/devices/factory-console/history");
    const breadcrumb = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
    expect(breadcrumb.getByText("factory-console")).toHaveAttribute("aria-current", "page");
    act(() => {
      window.history.pushState(null, "", "/devices/factory-gpu");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByText("critical")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Agent link" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "UPS" })).toHaveAttribute("href", "/ups");
  });
});

describe("devices page", () => {
  it("renders maintenance counts, services and warnings without changing host health", () => {
    const data = view();
    data.device.health = { status: "healthy", reasons: [] };
    data.device.drives[0]!.unsafe_shutdowns = 129;
    data.maintenance = {
      availability: "available",
      schema: 1,
      observed_at_ms: 1_000,
      updates: { availability: "available", security: 2, other: 7 },
      held: { availability: "available", packages: ["linux-t2", "example"] },
      services: {
        availability: "available",
        unattended_upgrades: "enabled",
        fstrim_timer: "disabled",
        smartd: "absent",
      },
      unattended_auto_reboot: { availability: "available", value: true },
      tailscale_auto_update: { availability: "available", check: true, apply: false },
      journal_bytes: { availability: "available", value: 104857600 },
    };
    const page = () => (
      <DevicesPage
        deviceId="factory-gpu"
        view={data}
        history={null}
        range="1h"
        setRange={() => {}}
        error={null}
        loading={false}
        connected
        live
        now={2_000}
      />
    );
    const { rerender } = render(page());
    const card = within(screen.getByRole("region", { name: "Maintenance" }));
    expect(card.getByText("2 security · 7 other")).toBeInTheDocument();
    expect(card.getByText("linux-t2, example")).toBeInTheDocument();
    expect(card.getByText("Check on · apply off")).toBeInTheDocument();
    expect(card.getByText("100 MiB")).toBeInTheDocument();
    expect(card.getByText("129")).toBeInTheDocument();
    expect(card.getByText(/Maintenance snapshot: available/)).toBeInTheDocument();
    expect(card.getByLabelText("Warning: fstrim.timer disabled")).toBeInTheDocument();
    expect(card.getByLabelText("Warning: smartd absent")).toBeInTheDocument();
    expect(card.getByLabelText("Warning: unattended auto-reboot enabled")).toBeInTheDocument();
    expect(screen.getByText("healthy")).toBeInTheDocument();

    data.maintenance = {
      ...data.maintenance,
      availability: "stale",
      updates: { availability: "error", error: "probe failed" },
      held: { availability: "available", packages: [] },
      services: { ...data.maintenance.services, smartd: "unknown", availability: "error" },
      unattended_auto_reboot: { availability: "unsupported" },
    };
    rerender(page());
    expect(card.getByText(/Maintenance snapshot: stale/)).toBeInTheDocument();
    expect(card.queryByText("2 security · 7 other")).not.toBeInTheDocument();
    expect(card.getByText("None")).toBeInTheDocument();
    expect(card.getByText("Check on · apply off")).toBeInTheDocument();
    expect(card.getByLabelText("Warning: smartd unknown")).toBeInTheDocument();
    expect(
      card.queryByLabelText("Warning: unattended auto-reboot enabled"),
    ).not.toBeInTheDocument();
    data.maintenance = { availability: "permission_denied", error: "snapshot not readable" };
    rerender(page());
    expect(card.getByText(/Maintenance snapshot: permission denied/)).toBeInTheDocument();
    expect(card.getByText("129")).toBeInTheDocument();
    expect(card.queryByText("100 MiB")).not.toBeInTheDocument();
    data.maintenance = null;
    rerender(page());
    expect(card.getByText(/no readable snapshot/)).toBeInTheDocument();
  });

  it("renders health reasons and an em dash for unknown readings", () => {
    expect(metricText(metric(null))).toBe("—");
    expect(metricText(metric(null))).not.toBe("0");
    render(
      <DevicesPage
        deviceId="factory-gpu"
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
    // Only nodes with a device page are links; factory-console and factory-edge stay plain tiles.
    const fleet = await screen.findByRole("region", { name: "Fleet" });
    expect(await within(fleet).findAllByRole("link")).toHaveLength(1);
    fireEvent.click(within(fleet).getByRole("link", { name: /factory-gpu/ }));
    expect(window.location.pathname).toBe("/devices/factory-gpu");
    expect(await screen.findByRole("heading", { name: "Host health" })).toBeInTheDocument();
    const breadcrumb = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
    expect(breadcrumb.getByRole("link", { name: "factory" })).toHaveAttribute("href", "/");
    expect(breadcrumb.getByRole("link", { name: "devices" })).toHaveAttribute("href", "/");
    expect(breadcrumb.getByText("factory-gpu")).toHaveAttribute("aria-current", "page");
    act(() => {
      window.history.back();
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(
      screen.getByRole("heading", { name: "Your local compute. In focus." }),
    ).toBeInTheDocument();
  });
});
