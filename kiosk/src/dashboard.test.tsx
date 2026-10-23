import { render, screen, within, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import App from "./App";
import { agentFixtures, fixtures } from "../mock/fixtures";
import { networkFixtures } from "../mock/site-fixtures";
import { streamReducer, initialLiveState, parseEvent, STREAM_SILENCE_MS } from "./api/stream";
import type { StreamEvent, UpsCurrent } from "./api/types";
import { UpsBadge, UpsSection } from "./components/ups";
import UpsPage from "./components/ups-page";
import { TooltipProvider } from "./components/ui/tooltip";
import { count, ms, usd, number, seen } from "./lib/format";
import { upsChartData } from "./lib/ups";
import { AgentsSection, FleetSection, TickerSection } from "./components/sections";
import { VersionFooter } from "./components/version-footer";
const openLlmDetails = async () => {
  fireEvent.click(screen.getByRole("link", { name: "Local LLM usage, pricing and model details" }));
  return screen.findByRole("heading", { name: "Local LLM · Usage & spend" });
};
// Captured from the real sandbox API; synthetic quotas include the reported label and percentages.
import capturedUsage from "./agents-usage.sse?raw";

class MockSource extends EventTarget {
  static latest: MockSource;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  constructor() {
    super();
    MockSource.latest = this;
  }
  close() {}
}
beforeEach(() => {
  window.history.replaceState(null, "", "/");
  document.documentElement.dataset.theme = "dark";
  delete document.documentElement.dataset.themePreference;
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("EventSource", MockSource);
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
});
function api(outage = false, failing = "", empty = false) {
  const fetch = vi.fn((path: string) => {
    const url = new URL(path, "http://localhost");
    if (url.pathname === "/control/v1/state")
      return Promise.resolve(
        new Response(JSON.stringify({ error: "controls denied" }), { status: 403 }),
      );
    const data = fixtures(outage, url.searchParams.get("range") === "7d" ? "7d" : "24h");
    data.fleet.nodes[0]!.services[0]!.name = "renamed-meter";
    if (empty) {
      data.fleet.nodes = [];
      data.usage.models = [];
      data.usage.spend_avoided = [];
      data.gpu.history = [];
      data.agents.tools = [];
      data.pricing.families = [];
    }
    const network = networkFixtures("healthy", outage);
    const routes: Record<string, unknown> = {
      "/v1/health": data.health,
      "/v1/fleet": data.fleet,
      "/v1/llm/usage": data.usage,
      "/v1/gpu": data.gpu,
      "/v1/network": network.status,
      "/v1/network/history": network.history,
      "/v1/ups": { generated_at_ms: Date.now(), current: null, warnings: [] },
      "/v1/devices": {
        generated_at_ms: Date.now(),
        devices: [{ device_id: "factory-gpu", health: "unknown", href: "/devices/factory-gpu" }],
      },
      "/v1/devices/factory-gpu": null,
      "/v1/devices/factory-gpu/history": {
        device_id: "factory-gpu",
        range: "1h",
        generated_at_ms: Date.now(),
        points: [],
      },
      "/v1/ups/history": [],
      "/v1/ups/events": {
        events: [
          {
            id: 9,
            kind: "on_battery",
            started_ms: Date.now() - 60_000,
            ended_ms: Date.now(),
            min_charge_percent: 43,
            min_runtime_s: 512,
            detail: "Outage",
            end_reason: "restart",
          },
        ],
        next_before_ms: null,
        next_before_id: null,
      },
      "/v1/ups/energy": {
        energy_mwh: 1234567,
        cost_nano_usd: null,
        coverage_percent: 20,
        gpu_energy_mwh: 500000,
      },
      "/v1/settings/ups": { electricity_rate_micro_usd_per_kwh: null, battery_installed_ms: null },
      "/v1/pricing": data.pricing,
      "/v1/agents": data.agents,
    };
    return Promise.resolve(
      new Response(JSON.stringify(routes[url.pathname]), {
        status: url.pathname === failing ? 503 : 200,
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const upsSample = (flags: string[], ts_ms = Date.now()): UpsCurrent => ({
  ts_ms,
  flags,
  status: flags.join(" "),
  on_line: flags.includes("OL"),
  on_battery: flags.includes("OB"),
  low_battery: flags.includes("LB"),
  replace_battery: flags.includes("RB"),
  charge_percent: 48,
  charge_warning_percent: 20,
  charge_low_percent: 30,
  runtime_s: 847,
  runtime_low_s: 300,
  load_w: 144,
  load_nominal_w: 600,
  load_percent: 24,
  input_v: 121,
  output_v: 120,
  battery_v: 25.9,
  test_result: "Done and passed",
  model: "CyberPower synthetic",
});
describe("UPS telemetry", () => {
  it("matches nearest GPU samples within 30 seconds without carrying across gaps", () => {
    const history = [100, 300, 229, 10, 370, 431, 40].map((seconds) => ({
      ts_ms: seconds * 1000,
      sample_count: 1,
      load_w: { min: 90, avg: 100, max: 110 },
      input_v: { min: 119, avg: 120, max: 121 },
      charge_percent: { min: 80, avg: 85, max: 90 },
      runtime_s: 600,
    }));
    // Sorted GPU timestamps include duplicates; UPS timestamps need not be sorted.
    const gpu = [10, 10, 71, 131, 210, 239, 400].map((seconds) => ({
      ...fixtures().gpu.history[0]!,
      ts_ms: seconds * 1000,
      power_w: seconds,
    }));
    const data = upsChartData(history, gpu);
    expect(data.map((point) => point.gpu)).toEqual([71, undefined, 239, 10, 400, undefined, 10]);
    expect(data[0]).toEqual({
      ts_ms: 100_000,
      load: 100,
      input: 120,
      charge: 85,
      runtime: 10,
      gpu: 71,
    });
    expect(upsChartData(history, []).every((point) => point.gpu === undefined)).toBe(true);
  });
  it("refetches null SSE warnings and keeps the cause in the card and badge tooltip", async () => {
    const fetch = api();
    const defaults = fetch.getMockImplementation()!;
    let warning = "ups: initial failure";
    fetch.mockImplementation((path) =>
      path === "/v1/ups"
        ? Promise.resolve(
            new Response(
              JSON.stringify({ generated_at_ms: Date.now(), current: null, warnings: [warning] }),
            ),
          )
        : defaults(path),
    );
    render(<App />);
    expect(await screen.findByText(warning)).toBeInTheDocument();
    warning = "ups: ERR DATA-STALE";
    act(() => {
      MockSource.latest.dispatchEvent(
        new MessageEvent("ups.sample", {
          data: JSON.stringify({ type: "ups.sample", ts_ms: Date.now() + 1, data: null }),
        }),
      );
    });
    expect(await screen.findByText(warning)).toBeInTheDocument();
    act(() => screen.getByRole("link", { name: "UPS: No data" }).focus());
    expect(await screen.findByText(/UPS: No data · Charge/)).toHaveTextContent(warning);
    expect(screen.queryByText("ups: initial failure")).not.toBeInTheDocument();
  });
  it.each([null, "stale"])("shows warning in the %s badge tooltip", async (mode) => {
    render(
      <TooltipProvider>
        <UpsBadge
          current={mode ? upsSample(["OL"], Date.now() - 31_000) : null}
          now={Date.now()}
          warnings={["ups: ERR DATA-STALE"]}
        />
      </TooltipProvider>,
    );
    act(() => screen.getByRole("link", { name: "UPS: No data" }).focus());
    expect(await screen.findByText(/UPS: No data · Charge/)).toHaveTextContent(
      "ups: ERR DATA-STALE",
    );
  });
  it("routes /ups, switches every chart range, and renders restart wording and settings", async () => {
    window.history.replaceState(null, "", "/ups");
    const fetch = api();
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "UPS · Power & battery" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("factory shut down during outage")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Local LLM" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Controls" })).toHaveTextContent(
      "Controls available from Devon's or David's devices",
    );
    for (const range of ["1h", "7d", "30d", "365d", "24h"]) {
      fireEvent.click(screen.getByRole("button", { name: range }));
      await waitFor(() =>
        expect(fetch).toHaveBeenCalledWith(`/v1/ups/history?range=${range}`, expect.anything()),
      );
      expect(screen.getByRole("button", { name: range })).toHaveAttribute("aria-pressed", "true");
    }
    const rate = await screen.findByLabelText("Electricity rate · USD per kWh");
    for (const invalid of ["0.1234567", "-0.1"]) {
      fireEvent.change(rate, { target: { value: invalid } });
      fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
      const alert = screen.getByRole("alert");
      expect(alert).toHaveAttribute("data-slot", "alert");
      expect(alert).toHaveTextContent("nonnegative USD rate with at most 6 decimals");
      expect(alert).toHaveTextContent(
        "Settings may not have been saved; select Save settings to try again.",
      );
      expect(alert.textContent).not.toContain("..");
      expect(alert).not.toHaveTextContent("Retrying");
      expect(rate).toHaveAccessibleDescription(/nonnegative USD rate with at most 6 decimals/);
    }
    fireEvent.change(rate, { target: { value: "0.123456" } });
    fireEvent.change(screen.getByLabelText("Battery installed date"), {
      target: { value: "2024-02-29" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/v1/settings/ups",
        expect.objectContaining({
          method: "PUT",
          body: '{"electricity_rate_micro_usd_per_kwh":123456,"battery_installed_ms":1709164800000}',
        }),
      ),
    );
    expect(await screen.findByText("Settings saved.")).toBeInTheDocument();
  });
  it("shows a failed settings PUT in the shared Alert with the server's exact message", async () => {
    window.history.replaceState(null, "", "/ups");
    const fetch = api();
    const defaults = fetch.getMockImplementation()!;
    fetch.mockImplementation((path: string, init?: RequestInit) =>
      path === "/v1/settings/ups" && init?.method === "PUT"
        ? Promise.resolve(
            new Response(JSON.stringify({ error: { message: "settings store is read-only" } }), {
              status: 503,
            }),
          )
        : defaults(path),
    );
    render(<App />);
    const rate = await screen.findByLabelText("Electricity rate · USD per kWh");
    fireEvent.change(rate, { target: { value: "0.123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("data-slot", "alert");
    expect(alert).toHaveTextContent("Settings not saved");
    expect(alert).toHaveTextContent("settings store is read-only");
    expect(alert).toHaveTextContent(
      "Settings may not have been saved; select Save settings to try again.",
    );
    expect(alert).not.toHaveTextContent("Retrying");
    expect(rate).toHaveAccessibleDescription(/settings store is read-only/);
    expect(rate).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText("Settings saved.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled();
  });
  it("never shows a negative duration for an event newer than the UI clock", async () => {
    window.history.replaceState(null, "", "/ups");
    const fetch = api();
    const defaults = fetch.getMockImplementation()!;
    fetch.mockImplementation((path) =>
      path.startsWith("/v1/ups/events")
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                events: [{ id: 1, kind: "on_battery", started_ms: Date.now() + 2000 }],
                next_before_ms: null,
                next_before_id: null,
              }),
            ),
          )
        : defaults(path),
    );
    render(<App />);
    expect(await screen.findByText(/Duration 0 ms · ongoing/)).toBeInTheDocument();
  });
  it("counts down the runtime reserve, stops at 30% charge, and expires stale telemetry", () => {
    api();
    const now = Date.now();
    const current = upsSample(["OB"], now);
    const props = { current, now, warnings: [], live: initialLiveState, revision: 0 };
    const view = render(<UpsPage {...props} />);
    const live = screen.getByRole("region", { name: "Live UPS" });
    expect(within(live).getByText("547 s")).toBeInTheDocument();
    view.rerender(<UpsPage {...props} now={now + 2000} />);
    expect(within(live).getByText("545 s")).toBeInTheDocument();
    view.rerender(<UpsPage {...props} current={{ ...current, charge_percent: 30 }} />);
    expect(within(live).getByText("0 s")).toBeInTheDocument();
    view.rerender(<UpsPage {...props} current={{ ...current, runtime_s: 300 }} />);
    expect(within(live).getByText("0 s")).toBeInTheDocument();
    view.rerender(<UpsPage {...props} now={now + 30_001} />);
    expect(within(live).getByText("No data")).toBeInTheDocument();
    expect(within(live).queryByText("144 W")).not.toBeInTheDocument();
  });
  it("pages tied event cursors, refreshes on ups.event, and limits hourly health to 70–110 W", async () => {
    window.history.replaceState(null, "", "/ups");
    const fetch = api();
    const defaults = fetch.getMockImplementation()!;
    let detail = "Passed self-test";
    const at = Date.now() - 3_600_000;
    fetch.mockImplementation((path) => {
      if (path === "/v1/ups/history?range=365d")
        return Promise.resolve(
          new Response(
            JSON.stringify(
              [69, 70, 110, 111].map((load, index) => ({
                ts_ms: at + index * 1000,
                sample_count: 360,
                load_w: { min: load, avg: load, max: load },
                charge_percent: { min: 70, avg: 75, max: 80 },
                input_v: { min: 120, avg: 121, max: 122 },
                runtime_s: 400 + index * 100,
              })),
            ),
          ),
        );
      if (path.startsWith("/v1/ups/events"))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              events: [{ id: 9, kind: "self_test", started_ms: at, ended_ms: at, detail }],
              next_before_ms: path.includes("before_ms") || path.includes("limit=200") ? null : at,
              next_before_id: 9,
            }),
          ),
        );
      return defaults(path);
    });
    render(<App />);
    const health = await screen.findByRole("region", { name: "Hourly runtime trend" });
    expect(within(health).getAllByRole("row")).toHaveLength(3);
    expect(within(health).getByText("70")).toBeInTheDocument();
    expect(within(health).getByText("110")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Battery health" })).toHaveTextContent(
      new Date(at).toLocaleString(),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Older events" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        `/v1/ups/events?limit=20&before_ms=${at}&before_id=9`,
        expect.anything(),
      ),
    );
    detail = "New self-test result";
    act(() => {
      MockSource.latest.dispatchEvent(
        new MessageEvent("ups.event", {
          data: JSON.stringify({
            type: "ups.event",
            ts_ms: Date.now(),
            data: { id: 10, kind: "self_test", started_ms: at, ended_ms: at, detail },
          }),
        }),
      );
    });
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Power events" })).toHaveTextContent(detail),
    );
  });
  it.each([
    ["OL", "Online", "plug"],
    ["OL OB RB", "On battery", "battery-warning"],
    ["OL OB LB RB", "Low battery", "battery-warning"],
    ["OL RB", "Replace battery", "plug"],
    [null, "No data", "battery"],
    ["stale", "No data", "battery"],
  ])("renders %s card and badge", (flags, label, icon) => {
    const now = Date.now();
    const current =
      flags === null
        ? null
        : upsSample(
            flags === "stale" ? ["OL"] : flags.split(" "),
            flags === "stale" ? now - 30_001 : now,
          );
    render(
      <TooltipProvider>
        <UpsBadge current={current} now={now} />
        <UpsSection current={current} now={now} warnings={[]} />
      </TooltipProvider>,
    );
    const card = screen.getByRole("region", { name: "UPS" });
    expect(within(card).getByText(label!)).toBeInTheDocument();
    const badge = screen.getByRole("link", { name: `UPS: ${label}` });
    expect(badge).toHaveAttribute("href", "/ups");
    expect(badge.querySelector(`.lucide-${icon}`)).not.toBeNull();
    if (label === "On battery" || label === "Low battery") expect(badge).toHaveClass("status-fail");
    else expect(badge).not.toHaveClass("status-fail");
    if (label === "Replace battery") expect(badge).toHaveClass("status-warn");
    if (label !== "No data") {
      expect(within(card).getByText("14 m 7 s")).toBeInTheDocument();
      expect(within(card).getByText("144 W of 600 W")).toBeInTheDocument();
      expect(within(card).getByText(/Warning 20% · Low\/shutdown 30%/)).toBeInTheDocument();
    } else expect(within(card).queryByText("48%")).not.toBeInTheDocument();
  });
  it("shows telemetry and age in the keyboard tooltip", async () => {
    const now = Date.now();
    render(
      <TooltipProvider>
        <UpsBadge current={upsSample(["OL"], now - 2000)} now={now} />
      </TooltipProvider>,
    );
    act(() => screen.getByRole("link", { name: "UPS: Online" }).focus());
    expect(await screen.findByText(/UPS: Online · Charge 48%/)).toHaveTextContent(
      "UPS: Online · Charge 48% · Runtime 14 m 7 s · Load 144 W · Input 121 V · Sample age 2 s",
    );
  });
  it("updates from named SSE, clears on failure, and expires without another event", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    api();
    await act(async () => {
      render(<App />);
    });
    expect(screen.getByRole("link", { name: "UPS: No data" })).toBeInTheDocument();
    const emit = (data: UpsCurrent | null) =>
      MockSource.latest.dispatchEvent(
        new MessageEvent("ups.sample", {
          data: JSON.stringify({ type: "ups.sample", ts_ms: Date.now() + 1, data }),
        }),
      );
    act(() => {
      emit(upsSample(["OB"]));
    });
    expect(screen.getByRole("link", { name: "UPS: On battery" })).toBeInTheDocument();
    act(() => {
      emit(null);
    });
    expect(screen.getByRole("link", { name: "UPS: No data" })).toBeInTheDocument();
    const at = Date.now();
    act(() => {
      emit(upsSample(["OL"], at));
    });
    expect(screen.getByRole("link", { name: "UPS: Online" })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByRole("link", { name: "UPS: Online" })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("link", { name: "UPS: No data" })).toBeInTheDocument();
    vi.useRealTimers();
  });
});
describe("human formats", () => {
  it("formats units, boundaries, nulls and zero without confusing them", () => {
    expect(count(1_240_000)).toBe("1.2M");
    expect(count(0)).toBe("0");
    expect(usd(3.41)).toBe("$3.41");
    expect(usd(0)).toBe("$0.00");
    expect(ms(812)).toBe("812 ms");
    expect(ms(999)).toBe("999 ms");
    expect(ms(1000)).toBe("1 s");
    expect(ms(2460)).toBe("2.5 s");
    expect(ms(60_000)).toBe("1 min");
    expect(ms(3_600_000)).toBe("1 h");
    expect(ms(86_400_000)).toBe("1 d");
    expect(number(81.43)).toBe("81.4");
    expect(seen(0, 1500)).toBe("1.5 s ago");
    for (const format of [count, usd, ms, number, seen]) expect(format(null)).toBe("—");
  });
});
describe("dashboard contract", () => {
  it.each([
    [false, null, "Use dark theme", "dark"],
    [true, null, "Use light theme", "light"],
    [false, "dark", "Use light theme", null],
    [true, "light", "Use dark theme", null],
  ] as const)(
    "keeps the pre-paint theme with system dark=%s and preference=%s",
    (systemDark, saved, label, stored) => {
      api();
      vi.stubGlobal("matchMedia", () => ({
        matches: systemDark,
        addEventListener() {},
        removeEventListener() {},
      }));
      document.documentElement.dataset.theme = saved ?? (systemDark ? "dark" : "light");
      if (saved) document.documentElement.dataset.themePreference = saved;
      render(<App />);
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(
        screen.getByRole("button", {
          name: label === "Use dark theme" ? "Use light theme" : "Use dark theme",
        }),
      ).toBeVisible();
      expect(localStorage.getItem("factory-theme")).toBe(stored);
    },
  );
  it("returns from a saved light override to the dark system and follows later changes", () => {
    api();
    const media = Object.assign(new EventTarget(), { matches: true });
    vi.stubGlobal("matchMedia", () => media);
    localStorage.setItem("factory-theme", "light");
    document.documentElement.dataset.theme = "light";
    document.documentElement.dataset.themePreference = "light";
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Use dark theme" }));
    expect(localStorage.getItem("factory-theme")).toBeNull();
    expect(document.documentElement).not.toHaveAttribute("data-theme-preference");
    expect(screen.getByRole("button", { name: "Use light theme" })).toBeVisible();
    act(() => {
      media.matches = false;
      media.dispatchEvent(Object.assign(new Event("change"), { matches: false }));
    });
    expect(screen.getByRole("button", { name: "Use dark theme" })).toBeVisible();
  });
  it("preserves an explicit light override when remounting from the saved head theme", () => {
    api();
    const { unmount } = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Use light theme" }));
    expect(localStorage.getItem("factory-theme")).toBe("light");
    unmount();
    // The blocking head script supplies these attributes on a full reload.
    document.documentElement.dataset.theme = localStorage.getItem("factory-theme")!;
    document.documentElement.dataset.themePreference = localStorage.getItem("factory-theme")!;
    render(<App />);
    expect(screen.getByRole("button", { name: "Use dark theme" })).toBeVisible();
    expect(localStorage.getItem("factory-theme")).toBe("light");
  });
  it("warns only on an API contract mismatch and preserves dirty and unknown warnings", () => {
    const build = {
      version: "0.2.0",
      git_sha: "a1b2c3d",
      git_dirty: false,
      built_at_ms: 1_790_000_000_000,
      inputs_fingerprint: "012345abcdef",
      expected_openapi_sha256: "9ece56431fd2",
    };
    const health = {
      ...build,
      inputs_fingerprint: "111111111111",
      openapi_sha256: "9ece56431fd2",
      status: "ok",
      uptime_ms: 123,
      retention: { status: "pending", pruned_rows: 0, pruned_rows_since_start: 0 },
    };
    const meter = {
      ...fixtures().fleet.nodes[0]!.services[0]!,
      ...build,
      inputs_fingerprint: "222222222222",
    };
    const { rerender } = render(<VersionFooter api={health} meter={meter} kiosk={build} />);
    const footer = screen.getByRole("contentinfo", { name: "Running versions" });
    expect(footer).toHaveTextContent("factory v0.2.0api a1b2c3dkiosk a1b2c3dmeter a1b2c3d");
    expect(within(footer).queryByRole("status")).not.toBeInTheDocument();
    // Same contract, every component on a different commit, version and inputs: no warning.
    rerender(
      <VersionFooter
        api={{ ...health, git_sha: "b0f521b", inputs_fingerprint: "444444444444" }}
        meter={{ ...meter, git_sha: "0536fc1", version: "0.1.0", inputs_fingerprint: "333" }}
        kiosk={{ ...build, git_sha: "fd58f8e" }}
      />,
    );
    expect(footer).toHaveTextContent("api b0f521bkiosk fd58f8emeter 0536fc1");
    expect(within(footer).queryByRole("status")).not.toBeInTheDocument();
    rerender(
      <VersionFooter
        api={{ ...health, openapi_sha256: "000000000000" }}
        meter={meter}
        kiosk={build}
      />,
    );
    expect(within(footer).getByRole("status")).toHaveTextContent("Build mismatch");
    expect(within(footer).getByRole("status")).toHaveAttribute(
      "title",
      "API contract mismatch: kiosk built against OpenAPI 9ece56431fd2, api serves 000000000000",
    );
    // An API that predates the contract hash cannot assert a mismatch.
    const { openapi_sha256: _hash, ...legacyHealth } = health;
    rerender(<VersionFooter api={legacyHealth as typeof health} meter={meter} kiosk={build} />);
    expect(within(footer).queryByRole("status")).not.toBeInTheDocument();
    rerender(
      <VersionFooter api={health} meter={{ ...meter, inputs_fingerprint: null }} kiosk={build} />,
    );
    expect(footer).toHaveTextContent("meter a1b2c3d (inputs unknown)");
    expect(footer).not.toHaveTextContent("Build mismatch");
    rerender(<VersionFooter api={health} meter={{ ...meter, git_dirty: true }} kiosk={build} />);
    expect(within(footer).getByRole("status")).toHaveTextContent("Dirty build");
    expect(footer).not.toHaveTextContent("Build mismatch");
    rerender(<VersionFooter api={health} meter={{ ...meter, git_sha: "unknown" }} kiosk={build} />);
    expect(footer).toHaveTextContent("meter unknown");
    expect(within(footer).getByRole("status")).toHaveTextContent("Build identity incomplete");
    expect(footer).not.toHaveTextContent("Build mismatch");
    rerender(<VersionFooter api={null} meter={undefined} kiosk={build} />);
    expect(footer).toHaveTextContent("api unknown");
    expect(footer).toHaveTextContent("meter unknown");
    expect(footer).not.toHaveTextContent("Build mismatch");
  });
  it("shows now only for online nodes without a last-seen timestamp", () => {
    const data = fixtures().fleet;
    data.nodes = [
      { name: "online-unknown", online: true, last_seen_ms: null, services: [] },
      { name: "offline-unknown", online: false, last_seen_ms: null, services: [] },
      { name: "online-dated", online: true, last_seen_ms: 0, services: [] },
    ];
    render(
      <FleetSection
        resource={{ data, error: null, loading: false }}
        devices={[
          { device_id: "collector-only", health: "healthy", href: "/devices/collector-only" },
        ]}
        icon={null}
      />,
    );
    const nodes = screen.getAllByRole("article");
    expect(nodes).toHaveLength(4);
    expect(screen.getByRole("link", { name: /collector-only/ })).toHaveAttribute(
      "href",
      "/devices/collector-only",
    );
    expect(nodes[3]).toHaveTextContent("Host health · healthy");
    expect(nodes[0]).toHaveTextContent("seen now");
    expect(nodes[1]).toHaveTextContent("seen —");
    expect(nodes[2]).toHaveTextContent(`seen ${seen(0)}`);
    expect(nodes[2]).not.toHaveTextContent("seen now");
  });
  it("renders every section, null tps, pricing estimates and a read-only pending banner", async () => {
    api();
    render(<App />);
    expect(screen.getAllByLabelText("Loading section").length).toBeGreaterThan(0);
    await screen.findByText("$3.41");
    expect(screen.getByRole("contentinfo", { name: "Running versions" })).toHaveTextContent(
      "meter a1b2c3d",
    );
    expect(
      within(screen.getByRole("region", { name: "Fleet" })).getByText("Offline"),
    ).toBeInTheDocument();
    expect(screen.getByText("Failing · —")).toBeInTheDocument();
    const usageCard = within(screen.getByRole("region", { name: "Local LLM" }));
    expect(usageCard.getByText("Pricing update pending")).toBeInTheDocument();
    expect(usageCard.getByText("+ $1.12 est.")).toBeInTheDocument();
    expect(usageCard.queryByRole("table")).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "GPU" })).getByText("9 GiB"),
    ).toBeInTheDocument();
    expect(await screen.findByLabelText("GPU utilization history")).toBeInTheDocument();
    await openLlmDetails();
    expect(screen.getByText("+ $1.12 estimated (pre-history)")).toBeInTheDocument();
    expect(
      screen.getByText(
        "New reference model available: anthropic/claude-sonnet-5.6. Confirm via CLI",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Claude Sonnet" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "ChatGPT mid-tier" })).toBeInTheDocument();
    expect(screen.getByText("8 unpriced · anthropic/claude-sonnet-5.5")).toBeInTheDocument();
    expect(screen.getByText("3 unpriced · openai/gpt-6.1-sol")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirm/i })).not.toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByText("— / 56.8")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "factory" }));
    await screen.findByRole("heading", { name: "Your local compute. In focus." });
    const tools = within(screen.getByRole("region", { name: "Frontier CLIs" }));
    expect(
      tools.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(["Amp", "Cursor", "Claude Code", "ChatGPT", "Kimi", "OpenCode"]);
    expect(tools.getByText("session cost: $1.25")).toBeInTheDocument();
    expect(tools.queryByText(/not tracked:/)).not.toBeInTheDocument();
    const event: StreamEvent = {
      type: "llm.request",
      ts_ms: 1000,
      data: {
        model: "factory-code",
        prompt_tokens: 1234,
        output_tokens: 456,
        latency_ms: 812,
        client_hostname: "test-client",
      },
    };
    act(() => {
      MockSource.latest.onopen?.();
      MockSource.latest.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));
      MockSource.latest.dispatchEvent(
        new MessageEvent("gpu.sample", {
          data: JSON.stringify({
            type: "gpu.sample",
            ts_ms: 1000,
            data: { ...fixtures().gpu.current, utilization_percent: 91 },
          }),
        }),
      );
    });
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByRole("log")).toHaveTextContent("test-client");
    expect(screen.getByText("91 %")).toBeInTheDocument();
    await act(() =>
      MockSource.latest.dispatchEvent(
        new MessageEvent("llm.request", {
          data: JSON.stringify({
            type: "llm.request",
            ts_ms: 1001,
            data: {
              model: null,
              prompt_tokens: null,
              output_tokens: null,
              latency_ms: 104,
              client_hostname: "unknown-usage",
            },
          }),
        }),
      ),
    );
    expect(screen.getByRole("log")).toHaveTextContent("Non-model request");
    expect(screen.getByRole("log")).toHaveTextContent("— in · — out");
    api(true);
    act(() => MockSource.latest.onerror?.());
    expect(screen.getByText("Reconnecting")).toBeInTheDocument();
    act(() => MockSource.latest.onopen?.());
    await screen.findByText("Meter unavailable. Usage cannot be retrieved.");
    expect(screen.getByText("Upstream unavailable")).toBeInTheDocument();
    expect(screen.getByRole("log")).toHaveTextContent("unknown-usage");
  });
  it("refreshes fleet, pricing and usage when their SSE change events arrive", async () => {
    api();
    render(<App />);
    await screen.findByText("$3.41");
    api(true);
    act(() =>
      MockSource.latest.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "fleet.change",
            ts_ms: 1,
            data: { node: "factory-gpu", service: "meter", ok: false },
          }),
        }),
      ),
    );
    await screen.findByText("Upstream unavailable");
    expect(screen.getByText("$3.41")).toBeInTheDocument();
    await act(() =>
      MockSource.latest.dispatchEvent(
        new MessageEvent("pricing.changed", {
          data: JSON.stringify({
            type: "pricing.changed",
            ts_ms: 2,
            data: { family: "Claude Sonnet", pending_model_id: null },
          }),
        }),
      ),
    );
    await screen.findByText("Pricing provider unavailable. Reference rates are unknown.");
    expect(screen.getByText("Meter unavailable. Usage cannot be retrieved.")).toBeInTheDocument();
  });
  it("renders outage nulls and warnings without dropping other sections", async () => {
    api(true);
    render(<App />);
    await screen.findByText("Meter unavailable. Usage cannot be retrieved.");
    expect(screen.getByText("Telemetry unavailable")).toBeInTheDocument();
    expect(
      screen.getByText("Pricing provider unavailable. Reference rates are unknown."),
    ).toBeInTheDocument();
    await openLlmDetails();
    expect(screen.getByText("No model requests in this range.")).toBeInTheDocument();
    expect(screen.getByText("ChatGPT mid-tier reference: — · rates: —")).toBeInTheDocument();
  });
  it("keeps endpoint errors isolated and exposes section empty states", async () => {
    api(false, "/v1/fleet", true);
    render(<App />);
    await screen.findByText("Unable to load this section");
    expect(screen.getByText(/HTTP 503/)).toBeInTheDocument();
    expect(screen.getByText("No frontier tools configured.")).toBeInTheDocument();
    expect(screen.getByText("No GPU history available.")).toBeInTheDocument();
    await openLlmDetails();
    expect(screen.getByText("No model requests in this range.")).toBeInTheDocument();
    expect(screen.getByText("No reference pricing configured.")).toBeInTheDocument();
  });
  it("changes the usage range", async () => {
    api();
    render(<App />);
    await screen.findByText("$3.41");
    expect(
      within(screen.getByRole("region", { name: "Local LLM" })).queryByRole("button"),
    ).not.toBeInTheDocument();
    await openLlmDetails();
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await screen.findByText("$23.87");
    fireEvent.click(screen.getByRole("link", { name: "factory" }));
    expect(await screen.findByText("$23.87")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Local LLM" })).toHaveTextContent("7d");
  });
  it("reopens the stream after silence and refetches on the next open, not before", async () => {
    vi.useFakeTimers();
    const fetch = api();
    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const first = MockSource.latest;
    const closed = vi.spyOn(first, "close");
    act(() => first.onopen?.());
    expect(screen.getByText("Live")).toBeInTheDocument();
    const fleetFetches = () =>
      fetch.mock.calls.filter(([path]: [string]) => path.startsWith("/v1/fleet")).length;
    // A keepalive event just under the limit keeps the socket.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STREAM_SILENCE_MS - 1);
    });
    act(() => first.onmessage?.(new MessageEvent("message", { data: "{}" })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STREAM_SILENCE_MS - 1);
    });
    expect(closed).not.toHaveBeenCalled();
    expect(screen.getByText("Live")).toBeInTheDocument();
    // Silence past the limit drops the socket and schedules a reopen within the first backoff.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(closed).toHaveBeenCalled();
    expect(screen.getByText("Reconnecting")).toBeInTheDocument();
    const before = fleetFetches();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(MockSource.latest).not.toBe(first);
    expect(fleetFetches()).toBe(before);
    act(() => MockSource.latest.onopen?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(fleetFetches()).toBe(before + 1);
    vi.useRealTimers();
  });
  it("refreshes displayed values at 60 seconds, not before", async () => {
    vi.useFakeTimers();
    api();
    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("$3.41")).toBeInTheDocument();
    // Change usage and agent capacity; the other contracts stay unchanged.
    const data = fixtures();
    data.agents.tools[0]!.balances[0]!.remaining = "123.45";
    vi.stubGlobal("fetch", (path: string) => {
      const routes: Record<string, unknown> = {
        "/v1/health": data.health,
        "/v1/fleet": data.fleet,
        "/v1/gpu": data.gpu,
        "/v1/pricing": data.pricing,
        "/v1/agents": data.agents,
        "/v1/llm/usage": {
          ...data.usage,
          spend_avoided: [
            {
              family: "ChatGPT mid-tier",
              model_id: null,
              usd: 17.89,
              estimated_usd: 0,
              unpriced_requests: 0,
            },
          ],
        },
      };
      return Promise.resolve(new Response(JSON.stringify(routes[path.split("?")[0] ?? ""])));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(screen.getByText("$3.41")).toBeInTheDocument();
    expect(screen.getByText(/\$171.27 of \$200/)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText("$17.89")).toBeInTheDocument();
    expect(screen.getByText(/\$123.45 of \$200/)).toBeInTheDocument();
  });
  it("slides in only the ticker rows that arrive after mount", () => {
    const request = (ts_ms: number, model: string) =>
      ({
        type: "llm.request",
        ts_ms,
        data: { model, prompt_tokens: 10, output_tokens: 5, latency_ms: 50, client_hostname: "c" },
      }) as const;
    // The stream starts empty on a normal load; the first row to arrive is new.
    const empty = render(<TickerSection requests={[]} connected />);
    empty.rerender(<TickerSection requests={[request(1000, "first")]} connected />);
    expect(screen.getByRole("heading", { name: "first" }).closest("li")).toHaveClass("fk-new");
    empty.unmount();
    // Rows present at mount stay still (newest first); a later arrival is the only new row.
    const existing = [request(2000, "older-b"), request(1000, "older-a")];
    const { rerender } = render(<TickerSection requests={existing} connected />);
    const olderB = screen.getByRole("heading", { name: "older-b" }).closest("li");
    expect(olderB).not.toHaveClass("fk-new");
    rerender(<TickerSection requests={[request(3000, "newer"), ...existing]} connected />);
    expect(screen.getByRole("heading", { name: "newer" }).closest("li")).toHaveClass("fk-new");
    expect(screen.getByRole("heading", { name: "older-b" }).closest("li")).toBe(olderB);
    expect(olderB).not.toHaveClass("fk-new");
    expect(screen.getByRole("heading", { name: "older-a" }).closest("li")).not.toHaveClass(
      "fk-new",
    );
  });
});
describe("frontier capacity", () => {
  it("labels workspace balances without changing unlabeled pools", () => {
    const data = agentFixtures();
    data.tools[0]!.balances.push({
      label: "workspace metacomet",
      unit: "usd",
      amount: "0",
      remaining: "0",
      total: null,
    });
    render(<AgentsSection resource={{ data, error: null, loading: false }} icon={null} />);
    expect(
      screen.getByText("$171.27 of $200 · 998.1 of 1,000 orb hours · workspace metacomet: $0"),
    ).toBeInTheDocument();
  });
  it("waits for a usage event, not a stale reconnect snapshot, and honors the cooldown", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const fetch = api();
    render(<App />);
    await screen.findByText("62,500 Codex credits");
    await act(async () => vi.advanceTimersByTime(60_000));
    const now = Date.now();
    fetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            status: "accepted",
            next_allowed_at_ms: now + 180_000,
          }),
          { status: 202 },
        ),
      ),
    );
    const button = screen.getByRole("button", { name: "Refresh usage" });
    button.focus();
    expect(button).toHaveFocus();
    expect(button.tagName).toBe("BUTTON");
    await act(async () => fireEvent.click(button));
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Next refresh in 180 s");
    expect(screen.getByText("Refreshing…")).toBeInTheDocument();
    await act(async () => {
      MockSource.latest.onopen?.();
      MockSource.latest.onopen?.();
    });
    expect(screen.getByText("Refreshing…")).toBeInTheDocument();
    await act(async () =>
      MockSource.latest.dispatchEvent(
        new MessageEvent("agents.usage", {
          data: JSON.stringify({ type: "agents.usage", ts_ms: now, data: agentFixtures() }),
        }),
      ),
    );
    expect(screen.getByText("Updated just now")).toBeInTheDocument();
    expect(screen.getByText("Next refresh in 3:00")).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(179_000);
    });
    expect(screen.getByText("Updated 2 min ago")).toBeInTheDocument();
    expect(screen.getByText("Next refresh in 0:01")).toBeInTheDocument();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Next refresh in 1 s");
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(button).toBeEnabled();
  });
  it.each([202, 429, 500])("handles refresh HTTP %s and a missing completion", async (status) => {
    vi.useFakeTimers();
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            next_allowed_at_ms: Date.now() + 180_000,
          }),
          { status },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const data = agentFixtures();
    for (const tool of data.tools) tool.observed_at_ms = null;
    render(<AgentsSection resource={{ data, error: null, loading: false }} icon={null} />);
    const button = screen.getByRole("button", { name: "Refresh usage" });
    expect(button).toBeEnabled();
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "/v1/agents/refresh",
      expect.objectContaining({ method: "POST" }),
    );
    if (status === 500) {
      expect(screen.getByText("Refresh didn't complete")).toBeInTheDocument();
      expect(button).toBeEnabled();
    } else {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", "Next refresh in 180 s");
      if (status === 202) {
        await act(async () => {
          vi.advanceTimersByTime(89_000);
        });
        expect(screen.getByText("Refreshing…")).toBeInTheDocument();
        await act(async () => {
          vi.advanceTimersByTime(1000);
        });
        expect(screen.getByText("Refresh didn't complete")).toBeInTheDocument();
        expect(screen.getByText("Next refresh in 1:30")).toBeVisible();
        expect(button).toBeDisabled();
      } else {
        expect(screen.queryByText("Refreshing…")).not.toBeInTheDocument();
        expect(screen.getByText("Next refresh in 3:00")).toBeVisible();
        expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
        await act(async () => vi.advanceTimersByTime(1000));
        expect(screen.getByText("Next refresh in 2:59")).toBeVisible();
      }
      await act(async () => vi.advanceTimersByTime(status === 202 ? 90_000 : 179_000));
      expect(screen.queryByText(/Next refresh in/)).not.toBeInTheDocument();
      expect(button).toBeEnabled();
    }
  });
  it("derives the initial cooldown from the newest snapshot observation without fetching", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const data = agentFixtures();
    for (const tool of data.tools) tool.observed_at_ms = Date.now() - 179_000;
    data.tools.find((tool) => tool.tool === "codex")!.observed_at_ms = Date.now() - 117_000;
    data.tools.find((tool) => tool.tool === "kimi")!.observed_at_ms = null;
    const { rerender } = render(
      <AgentsSection resource={{ data: null, error: null, loading: true }} icon={null} />,
    );
    rerender(<AgentsSection resource={{ data, error: null, loading: false }} icon={null} />);
    const button = screen.getByRole("button", { name: "Refresh usage" });
    expect(screen.getByText("Next refresh in 1:03")).toBeVisible();
    expect(button).toBeDisabled();
    // Snapshot invalidation must not temporarily clear a known cooldown.
    rerender(<AgentsSection resource={{ data: null, error: null, loading: true }} icon={null} />);
    await act(async () => vi.advanceTimersByTime(62_000));
    expect(screen.getByText("Next refresh in 0:01")).toBeVisible();
    expect(button).toBeDisabled();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(button).toBeEnabled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([202, 429])("retains the HTTP %s deadline across a session reload", async (status) => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ next_allowed_at_ms: Date.now() + 180_000 }), { status }),
        ),
      ),
    );
    const data = agentFixtures();
    for (const tool of data.tools) tool.observed_at_ms = null;
    const { unmount } = render(
      <AgentsSection resource={{ data, error: null, loading: false }} icon={null} />,
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh usage" })));
    unmount();
    await act(async () => vi.advanceTimersByTime(61_000));
    data.tools[0]!.observed_at_ms = Date.now();
    render(<AgentsSection resource={{ data, error: null, loading: false }} icon={null} />);
    expect(screen.getByText("Next refresh in 1:59")).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh usage" })).toBeDisabled();
    expect(screen.queryByText("Refreshing…")).not.toBeInTheDocument();
  });
  it("applies a captured named usage event even while its snapshot GET is stuck", async () => {
    vi.useFakeTimers();
    const fetch = api();
    render(<App />);
    await act(async () => {});
    await act(async () => vi.advanceTimersByTime(60_000));
    fetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ next_allowed_at_ms: Date.now() + 180_000 }), { status: 202 }),
      ),
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh usage" })));
    expect(screen.getByText("Refreshing…")).toBeVisible();
    fetch.mockImplementation(() => new Promise<Response>(() => {}));
    const [name, payload] = capturedUsage.trim().split("\n");
    await act(async () =>
      MockSource.latest.dispatchEvent(
        new MessageEvent(name!.slice("event: ".length), { data: payload!.slice("data: ".length) }),
      ),
    );
    expect(screen.getByText(/workspace metacomet: \$0/)).toBeVisible();
    const card = within(screen.getByRole("region", { name: "Frontier CLIs" }));
    expect(card.getAllByRole("progressbar").map((bar) => bar.getAttribute("value"))).toEqual([
      "15",
      "0",
      "7",
      "18",
      "0",
      "6",
    ]);
    expect(card.getByText("Updated just now")).toBeVisible();
    await act(async () => vi.advanceTimersByTime(90_000));
    expect(card.queryByText("Refresh didn't complete")).not.toBeInTheDocument();
    expect(card.getByText("Updated 1 min ago")).toBeVisible();
  });
  it("completes from a newer reconnect snapshot without replaying the missed event", async () => {
    vi.useFakeTimers();
    const fetch = api();
    const defaults = fetch.getMockImplementation()!;
    render(<App />);
    await act(async () => MockSource.latest.onopen?.());
    await act(async () => vi.advanceTimersByTime(60_000));
    fetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ next_allowed_at_ms: Date.now() + 180_000 }), { status: 202 }),
      ),
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh usage" })));
    await act(async () => vi.advanceTimersByTime(22_000));
    await act(async () => {
      MockSource.latest.onerror?.();
      MockSource.latest.onopen?.();
    });
    expect(screen.getByText("Refreshing…")).toBeVisible();
    const captured = parseEvent(JSON.parse(capturedUsage.trim().split("\n")[1]!.slice(6)));
    if (captured?.type !== "agents.usage") throw new Error("Invalid captured usage event");
    for (const tool of captured.data.tools)
      if (tool.observed_at_ms !== null) tool.observed_at_ms = Date.now();
    fetch.mockImplementation((path) =>
      path === "/v1/agents"
        ? Promise.resolve(new Response(JSON.stringify(captured.data)))
        : defaults(path),
    );
    await act(async () => {
      MockSource.latest.onerror?.();
      MockSource.latest.onopen?.();
    });
    expect(screen.getByText("Updated just now")).toBeVisible();
    expect(screen.getByText(/workspace metacomet: \$0/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh usage" })).toBeDisabled();
    await act(async () => vi.advanceTimersByTime(90_000));
    expect(screen.queryByText("Refresh didn't complete")).not.toBeInTheDocument();
  });
  it.each(["timer", "visibilitychange", "pageshow"])(
    "ends an accepted refresh without interval ticks on %s",
    async (trigger) => {
      vi.useFakeTimers();
      vi.stubGlobal("setInterval", () => 0);
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      try {
        vi.stubGlobal(
          "fetch",
          vi.fn(() =>
            Promise.resolve(
              new Response(JSON.stringify({ next_allowed_at_ms: Date.now() + 180_000 }), {
                status: 202,
              }),
            ),
          ),
        );
        const captured = parseEvent(JSON.parse(capturedUsage.trim().split("\n")[1]!.slice(6)));
        if (captured?.type !== "agents.usage") throw new Error("Invalid captured usage event");
        vi.setSystemTime(captured.ts_ms + 180_000);
        render(
          <AgentsSection
            resource={{ data: captured.data, error: null, loading: false }}
            icon={null}
          />,
        );
        await act(async () =>
          fireEvent.click(screen.getByRole("button", { name: "Refresh usage" })),
        );
        await act(async () => {
          if (trigger !== "timer") document.dispatchEvent(new Event("visibilitychange"));
        });
        await act(async () => vi.advanceTimersByTime(89_999));
        expect(screen.getByText("Refreshing…")).toBeVisible();
        await act(async () => {
          if (trigger === "timer") vi.advanceTimersByTime(1);
          else {
            vi.setSystemTime(Date.now() + 1);
            visibility.mockReturnValue("visible");
            (trigger === "pageshow" ? window : document).dispatchEvent(new Event(trigger));
          }
        });
        expect(screen.queryByText("Refreshing…")).not.toBeInTheDocument();
        expect(screen.getByText("Refresh didn't complete")).toBeVisible();
        if (trigger !== "timer") {
          await act(async () => {
            vi.setSystemTime(Date.now() + 90_000);
            document.dispatchEvent(new Event("visibilitychange"));
          });
          expect(screen.getByRole("button", { name: "Refresh usage" })).toBeEnabled();
          expect(screen.queryByText(/Next refresh in/)).not.toBeInTheDocument();
        }
      } finally {
        visibility.mockRestore();
      }
    },
  );
  it("shows independent balances, every window, UTC resets and observation age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T00:00:00Z"));
    const data = agentFixtures();
    render(<AgentsSection resource={{ data, error: null, loading: false }} icon={null} />);
    expect(screen.getByText("$171.27 of $200 · 998.1 of 1,000 orb hours")).toBeInTheDocument();
    expect(screen.getByText("62,500 Codex credits")).toBeInTheDocument();
    expect(screen.getByText("$12.5 of $50")).toBeInTheDocument();
    expect(screen.getByText("session cost: $1.25")).toBeInTheDocument();
    expect(screen.queryByText(/\$62,500/)).not.toBeInTheDocument();
    expect(screen.getByText("Plan: Gigawatt")).toBeInTheDocument();
    expect(screen.getAllByText("Plan: pro")).toHaveLength(2);
    expect(screen.getAllByText("Plan: —")).toHaveLength(3);
    expect(screen.getAllByText("Balance: —")).toHaveLength(2);
    expect(screen.getByText("observed 7 min ago")).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar").map((bar) => bar.getAttribute("value"))).toEqual([
      "14",
      "0",
      "13",
      "12",
      "0",
      "17",
      "20",
      "8",
      "35",
    ]);
    expect(screen.getByText("resets in 1.6 h")).toHaveAttribute(
      "title",
      "2026-10-13T01:35:00.000Z",
    );
    expect(screen.getByRole("listitem", { name: "Amp" })).toHaveAttribute("tabindex", "0");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("observed 8 min ago")).toBeInTheDocument();
  });
  it("renders null and omitted fields as unknown without inventing zero", () => {
    const data = agentFixtures();
    const amp = data.tools[0]!;
    amp.plan = null;
    amp.observed_at_ms = null;
    amp.windows[0]!.resets_at_ms = null;
    delete amp.windows[1]!.resets_at_ms;
    amp.balances = [];
    amp.balance = null;
    data.tools.find((tool) => tool.tool === "codex")!.balances = [];
    // Exercise the primary balance fallback independently of additive balances[].
    render(<AgentsSection resource={{ data, error: null, loading: false }} icon={null} />);
    const row = within(screen.getByRole("listitem", { name: "Amp" }));
    expect(row.getByText("Plan: —")).toBeInTheDocument();
    expect(row.getByText("observed —")).toBeInTheDocument();
    expect(row.getAllByText("resets in —")).toHaveLength(2);
    expect(row.getByText("Balance: —")).toBeInTheDocument();
    expect(screen.getByText("62,500 Codex credits")).toBeInTheDocument();
  });
  it.each(["stale", "unknown", "not_tracked"] as const)(
    "renders %s without implying live capacity",
    (status) => {
      const data = agentFixtures(status);
      // Unknown must suppress even supplied old values, not merely rely on empty fixtures.
      if (status === "unknown")
        data.tools[0] = { ...agentFixtures().tools[0]!, status, reason: "format changed" };
      if (status === "stale") data.tools[0]!.reason = "format changed";
      data.tools[0]!.cli_version = "0.0.1791864325-g52e626";
      const chatgpt = data.tools.find((tool) => tool.tool === "codex")!;
      chatgpt.cli_version = null;
      if (status !== "not_tracked") chatgpt.reason = "timeout";
      render(<AgentsSection resource={{ data, error: null, loading: false }} icon={null} />);
      expect(screen.queryByText(/not tracked:/)).not.toBeInTheDocument();
      if (status !== "not_tracked") {
        expect(screen.getByText("format changed (amp 0.0.1791864325-g52e626)")).toHaveClass(
          "status-warn",
        );
        expect(
          within(screen.getByRole("listitem", { name: "ChatGPT" })).getByText("timeout"),
        ).toHaveClass("status-warn");
      }
      if (status === "stale") {
        expect(screen.getAllByText("stale · observed 51 min ago")).toHaveLength(6);
        expect(screen.getByText(/\$171.27 of \$200/)).toBeInTheDocument();
        expect(screen.getAllByRole("progressbar")).toHaveLength(9);
      } else {
        expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
        expect(screen.queryByText(/\$171.27/)).not.toBeInTheDocument();
        expect(screen.getAllByText(status === "unknown" ? "unknown" : "not tracked")).toHaveLength(
          6,
        );
      }
    },
  );
  it("updates on agents.usage and recovers missed snapshots on reconnect", async () => {
    api();
    render(<App />);
    await screen.findByText("62,500 Codex credits");
    act(() => MockSource.latest.onopen?.());
    api(true);
    await act(() =>
      MockSource.latest.dispatchEvent(
        new MessageEvent("agents.usage", {
          data: JSON.stringify({
            type: "agents.usage",
            ts_ms: Date.now(),
            data: agentFixtures("unknown"),
          }),
        }),
      ),
    );
    expect(await screen.findAllByText(/usage source unavailable/)).toHaveLength(6);
    expect(screen.getByText("$3.41")).toBeInTheDocument();
    api();
    act(() => MockSource.latest.onerror?.());
    act(() => MockSource.latest.onopen?.());
    await screen.findByText("62,500 Codex credits");
    expect(screen.queryByText(/usage source unavailable/)).not.toBeInTheDocument();
  });
  it("isolates agents HTTP errors and recovers on the next usage event", async () => {
    api(false, "/v1/agents");
    render(<App />);
    await screen.findByText("$3.41");
    const card = within(screen.getByRole("region", { name: "Frontier CLIs" }));
    expect(card.getByRole("alert")).toHaveTextContent("HTTP 503");
    expect(screen.getByRole("region", { name: "Fleet" })).toHaveTextContent("factory-gpu");
    api();
    await act(() =>
      MockSource.latest.dispatchEvent(
        new MessageEvent("agents.usage", {
          data: JSON.stringify({ type: "agents.usage", ts_ms: Date.now(), data: agentFixtures() }),
        }),
      ),
    );
    await screen.findByText("62,500 Codex credits");
    expect(card.queryByRole("alert")).not.toBeInTheDocument();
  });
});
it("reduces all SSE types, bounds the ticker and rejects malformed frames", () => {
  let state = streamReducer(initialLiveState, {
    type: "gpu.sample",
    ts_ms: 10,
    data: fixtures().gpu.current ?? null,
  });
  state = streamReducer(state, {
    type: "fleet.change",
    ts_ms: 11,
    data: { node: "gpu", service: "meter", ok: false },
  });
  state = streamReducer(state, {
    type: "pricing.changed",
    ts_ms: 12,
    data: { family: "ChatGPT mid-tier", pending_model_id: null },
  });
  for (let i = 0; i < 9; i++)
    state = streamReducer(state, {
      type: "llm.request",
      ts_ms: i,
      data: {
        model: `model-${i}`,
        prompt_tokens: 11,
        output_tokens: 42,
        latency_ms: 812,
        client_hostname: "client",
      },
    });
  expect(state.requests.map((event) => event.data.model)).toEqual([
    "model-8",
    "model-7",
    "model-6",
    "model-5",
    "model-4",
    "model-3",
  ]);
  expect(state.fleetRevision).toBe(1);
  expect(state.pricingRevision).toBe(1);
  expect(state.gpu?.memory_total_mib).toBe(12288);
  expect(streamReducer(state, { type: "gpu.sample", ts_ms: 20, data: null }).gpu).toBeNull();
  expect(parseEvent({ type: "llm.request", ts_ms: 1, data: { model: "bad" } })).toBeNull();
  expect(parseEvent({ type: "gpu.sample", ts_ms: 1, data: null })).not.toBeNull();
  expect(parseEvent({ type: "invented", ts_ms: 1, data: {} })).toBeNull();
  expect(
    parseEvent({
      type: "agents.usage",
      ts_ms: 1,
      data: { tools: [{ tool: "amp", windows: null }] },
    }),
  ).toBeNull();
});
