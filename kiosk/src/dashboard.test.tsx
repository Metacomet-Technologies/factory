import { render, screen, within, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import App from "./App";
import { fixtures } from "../mock/fixtures";
import { streamReducer, initialLiveState, parseEvent } from "./api/stream";
import type { StreamEvent } from "./api/types";
import { count, ms, usd, number, seen } from "./lib/format";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { FleetSection } from "./components/sections";

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
    ).toEqual(["amp", "cursor", "claude-code", "codex", "kimi"]);
    expect(tools.getAllByText("Not tracked yet")).toHaveLength(5);
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
    // Only the usage request needs new data. Keep the other contracts unchanged.
    const data = fixtures();
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText("$17.89")).toBeInTheDocument();
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
});
