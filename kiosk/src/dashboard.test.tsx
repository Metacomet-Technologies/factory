import { render, screen, within, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import App from "./App";
import { agentFixtures, fixtures } from "../mock/fixtures";
import { streamReducer, initialLiveState, parseEvent } from "./api/stream";
import type { StreamEvent } from "./api/types";
import { count, ms, usd, number, seen } from "./lib/format";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { AgentsSection, FleetSection } from "./components/sections";
import { VersionFooter } from "./components/version-footer";
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
    const data = fixtures(outage, url.searchParams.get("range") === "7d" ? "7d" : "24h");
    if (empty) {
      data.fleet.nodes = [];
      data.usage.models = [];
      data.usage.spend_avoided = [];
      data.gpu.history = [];
      data.agents.tools = [];
      data.pricing.families = [];
    }
    const routes: Record<string, unknown> = {
      "/v1/health": data.health,
      "/v1/fleet": data.fleet,
      "/v1/llm/usage": data.usage,
      "/v1/gpu": data.gpu,
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
  it("compares component inputs, not SHAs, and preserves version, dirty and unknown warnings", () => {
    const build = {
      version: "0.2.0",
      git_sha: "a1b2c3d",
      git_dirty: false,
      built_at_ms: 1_790_000_000_000,
      inputs_fingerprint: "012345abcdef",
      expected_inputs: { api: "111111111111", meter: "222222222222" },
    };
    const health = { ...build, inputs_fingerprint: "111111111111", status: "ok", uptime_ms: 123 };
    const meter = {
      ...fixtures().fleet.nodes[0]!.services[0]!,
      ...build,
      inputs_fingerprint: "222222222222",
    };
    const { rerender } = render(<VersionFooter api={health} meter={meter} kiosk={build} />);
    const footer = screen.getByRole("contentinfo", { name: "Running versions" });
    expect(footer).toHaveTextContent("factory v0.2.0api a1b2c3dkiosk a1b2c3dmeter a1b2c3d");
    expect(within(footer).queryByRole("status")).not.toBeInTheDocument();
    rerender(<VersionFooter api={health} meter={{ ...meter, version: "0.1.0" }} kiosk={build} />);
    expect(within(footer).getByRole("status")).toHaveTextContent("Build mismatch");
    rerender(<VersionFooter api={{ ...health, git_sha: "7654321" }} meter={meter} kiosk={build} />);
    expect(within(footer).queryByRole("status")).not.toBeInTheDocument();
    rerender(<VersionFooter api={health} meter={{ ...meter, git_sha: "d07c8bc" }} kiosk={build} />);
    expect(within(footer).queryByRole("status")).not.toBeInTheDocument();
    rerender(
      <VersionFooter
        api={health}
        meter={{ ...meter, inputs_fingerprint: "333333333333" }}
        kiosk={build}
      />,
    );
    expect(within(footer).getByRole("status")).toHaveTextContent("Build mismatch");
    rerender(
      <VersionFooter
        api={{ ...health, inputs_fingerprint: "444444444444" }}
        meter={meter}
        kiosk={build}
      />,
    );
    expect(within(footer).getByRole("status")).toHaveTextContent("Build mismatch");
    rerender(
      <VersionFooter api={health} meter={{ ...meter, inputs_fingerprint: null }} kiosk={build} />,
    );
    expect(footer).toHaveTextContent("meter a1b2c3d (inputs unknown)");
    expect(footer).not.toHaveTextContent("Build mismatch");
    const { inputs_fingerprint: _fingerprint, ...legacyHealth } = health;
    rerender(<VersionFooter api={legacyHealth as typeof health} meter={meter} kiosk={build} />);
    expect(footer).toHaveTextContent("api a1b2c3d (inputs unknown)");
    expect(footer).not.toHaveTextContent("Build mismatch");
    rerender(<VersionFooter api={health} meter={{ ...meter, git_dirty: true }} kiosk={build} />);
    expect(within(footer).getByRole("status")).toHaveTextContent("Dirty build");
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
    render(<FleetSection resource={{ data, error: null, loading: false }} icon={null} />);
    const nodes = screen.getAllByRole("article");
    expect(nodes[0]).toHaveTextContent("Last seen now");
    expect(nodes[1]).toHaveTextContent("Last seen —");
    expect(nodes[2]).toHaveTextContent(`Last seen ${seen(0)}`);
    expect(nodes[2]).not.toHaveTextContent("Last seen now");
  });
  it("renders every section, null tps, pricing estimates and a read-only pending banner", async () => {
    api();
    render(<App />);
    expect(screen.getAllByLabelText("Loading section").length).toBeGreaterThan(0);
    await screen.findByText("$3.41");
    expect(
      within(screen.getByRole("region", { name: "Fleet" })).getByText("Offline"),
    ).toBeInTheDocument();
    expect(screen.getByText("Failing · —")).toBeInTheDocument();
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
    expect(
      within(screen.getByRole("region", { name: "GPU" })).getByText("9 GiB"),
    ).toBeInTheDocument();
    expect(await screen.findByLabelText("GPU utilization history")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByText("— / 56.8")).toBeInTheDocument();
    const tools = within(screen.getByRole("region", { name: "Frontier CLIs" }));
    expect(
      tools.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(["Amp", "Claude Code", "ChatGPT"]);
    expect(tools.getByText("not tracked: Cursor, Kimi")).toBeInTheDocument();
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
    expect(screen.getByText("No model requests in this range.")).toBeInTheDocument();
    expect(
      screen.getByText("Pricing provider unavailable. Reference rates are unknown."),
    ).toBeInTheDocument();
    expect(screen.getByText("ChatGPT mid-tier reference: — · rates: —")).toBeInTheDocument();
  });
  it("keeps endpoint errors isolated and exposes section empty states", async () => {
    api(false, "/v1/fleet", true);
    render(<App />);
    await screen.findByText("Unable to load this section");
    expect(screen.getByText(/HTTP 503/)).toBeInTheDocument();
    expect(screen.getByText("No model requests in this range.")).toBeInTheDocument();
    expect(screen.getByText("No frontier tools configured.")).toBeInTheDocument();
    expect(screen.getByText("No reference pricing configured.")).toBeInTheDocument();
    expect(screen.getByText("No GPU history available.")).toBeInTheDocument();
  });
  it("changes the usage range", async () => {
    api();
    render(<App />);
    await screen.findByText("$3.41");
    fireEvent.click(
      within(screen.getByRole("region", { name: "Local LLM" })).getByRole("button", { name: "7d" }),
    );
    await screen.findByText("$23.87");
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
  it("renders shadcn Base UI tabs and changes panels with a keyboard-accessible control", async () => {
    render(
      <Tabs defaultValue="first">
        <TabsList>
          <TabsTrigger value="first">First</TabsTrigger>
          <TabsTrigger value="second">Second</TabsTrigger>
        </TabsList>
        <TabsContent value="first">First panel</TabsContent>
        <TabsContent value="second">Second panel</TabsContent>
      </Tabs>,
    );
    expect(screen.getByRole("tab", { name: "First" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Second" }));
    await waitFor(() => expect(screen.getByRole("tabpanel")).toHaveTextContent("Second panel"));
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
    data.tools[0]!.observed_at_ms = Date.now() - 179_000;
    data.tools[2]!.observed_at_ms = Date.now() - 117_000;
    data.tools[3]!.observed_at_ms = null;
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
    expect(screen.queryByText(/\$62,500/)).not.toBeInTheDocument();
    expect(screen.getByText("Plan: Gigawatt")).toBeInTheDocument();
    expect(screen.getByText("Plan: —")).toBeInTheDocument();
    expect(screen.getByText("Balance: —")).toBeInTheDocument();
    expect(screen.getByText("observed 7 min ago")).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar").map((bar) => bar.getAttribute("value"))).toEqual([
      "14",
      "0",
      "13",
      "12",
      "0",
      "17",
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
    data.tools[2]!.balances = [];
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
      data.tools[2]!.cli_version = null;
      if (status !== "not_tracked") data.tools[2]!.reason = "timeout";
      render(<AgentsSection resource={{ data, error: null, loading: false }} icon={null} />);
      expect(screen.getByText("not tracked: Cursor, Kimi")).toBeInTheDocument();
      if (status !== "not_tracked") {
        expect(screen.getByText("format changed (amp 0.0.1791864325-g52e626)")).toHaveClass(
          "status-warn",
        );
        expect(
          within(screen.getByRole("listitem", { name: "ChatGPT" })).getByText("timeout"),
        ).toHaveClass("status-warn");
      }
      if (status === "stale") {
        expect(screen.getAllByText("stale · observed 51 min ago")).toHaveLength(3);
        expect(screen.getByText(/\$171.27 of \$200/)).toBeInTheDocument();
        expect(screen.getAllByRole("progressbar")).toHaveLength(6);
      } else {
        expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
        expect(screen.queryByText(/\$171.27/)).not.toBeInTheDocument();
        expect(screen.getAllByText(status === "unknown" ? "unknown" : "not tracked")).toHaveLength(
          3,
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
    expect(await screen.findAllByText(/usage source unavailable/)).toHaveLength(3);
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
