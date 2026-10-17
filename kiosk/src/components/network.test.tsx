import { act, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import App from "../App";
import { fixtures } from "../../mock/fixtures";
import { networkFixtures } from "../../mock/site-fixtures";
import type { NetworkSpeedTest, NetworkStatus } from "../api/types";

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

type Network = ReturnType<typeof networkFixtures>;
/** Serves the dashboard fixtures; `override` may answer a request first. */
function serve(network: Network = networkFixtures(), override?: (path: string) => unknown) {
  const data = fixtures();
  const fetch = vi.fn((path: string) => {
    const answer = override?.(path);
    if (answer) return answer;
    const url = new URL(path, "http://localhost");
    const routes: Record<string, unknown> = {
      "/v1/health": data.health,
      "/v1/fleet": data.fleet,
      "/v1/llm/usage": data.usage,
      "/v1/gpu": data.gpu,
      "/v1/ups": { generated_at_ms: Date.now(), current: null, warnings: [] },
      "/v1/pricing": data.pricing,
      "/v1/agents": data.agents,
      "/v1/devices": { generated_at_ms: Date.now(), devices: [] },
      "/v1/network": network.status,
      "/v1/network/history": network.history,
      "/v1/network/speed-tests": network.speedTests,
      "/v1/network/events": { events: network.events, next_before: null },
    };
    return Promise.resolve(new Response(JSON.stringify(routes[url.pathname] ?? null)));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));
const card = () => screen.findByRole("region", { name: "Network" });
const speedTest = (overrides: Partial<NetworkSpeedTest>): NetworkSpeedTest => ({
  id: 7,
  started_ms: Date.now() - 2 * 3_600_000,
  ended_ms: Date.now() - 2 * 3_600_000 + 11_000,
  outcome: "ok",
  download_bps: 938_400_000,
  upload_bps: 912_000_000,
  download_bytes: 440_000_000,
  upload_bytes: 290_000_000,
  idle_latency_ms: 9,
  download_loaded_latency_ms: 14,
  upload_loaded_latency_ms: 19,
  colo: "IAD",
  ...overrides,
});
/** Sets one wan target's latest burst: received of 10 replies and average RTT. */
function wan(status: NetworkStatus, target: string, received: number, avg_us: number) {
  const latest = status.targets.find((entry) => entry.target === target)!.latest!;
  latest.received = received;
  latest.rtt = { min_us: avg_us, avg_us, max_us: avg_us, mdev_us: 100 };
}

describe("network card", () => {
  it("shows the state, the latest test and the healthiest WAN target, and links to /network", async () => {
    const network = networkFixtures();
    network.status.latest_speed_test = speedTest({});
    wan(network.status, "1.1.1.1", 9, 12_300);
    wan(network.status, "8.8.8.8", 7, 15_000);
    serve(network);
    render(<App />);
    const region = within(await card());
    expect(await region.findByText("Healthy")).toBeInTheDocument();
    expect(region.getByText("938 Mb/s")).toBeInTheDocument();
    expect(region.getByText("912 Mb/s")).toBeInTheDocument();
    expect(region.getByText("Tested 2 h ago")).toBeInTheDocument();
    expect(region.getByText("Loaded latency 14 ms / 19 ms")).toBeInTheDocument();
    expect(region.getByText("12.3 ms")).toBeInTheDocument();
    expect(region.getByText("10%")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Network latency, loss and throughput" }),
    ).toHaveAttribute("href", "/network");
  });
  it.each([
    ["degraded", "Degraded · WAN latency"],
    ["down", "Down · WAN"],
  ] as const)("shows the %s fixture as %s", async (mode, label) => {
    serve(networkFixtures(mode));
    render(<App />);
    expect(await within(await card()).findByText(label)).toBeInTheDocument();
  });
  it("shows a skeleton while loading and an isolated error when the snapshot fails", async () => {
    serve(networkFixtures(), (path) => (path === "/v1/network" ? new Promise(() => {}) : null));
    const view = render(<App />);
    expect(within(await card()).getByLabelText("Loading section")).toBeInTheDocument();
    view.unmount();
    serve(networkFixtures(), (path) => (path === "/v1/network" ? json({}, 503) : null));
    render(<App />);
    const region = within(await card());
    expect(await region.findByText("Unable to load this section")).toBeInTheDocument();
    expect(region.getByText(/HTTP 503/)).toBeInTheDocument();
    expect(region.getByText("No data")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Fleet" })).toHaveTextContent("factory-gpu");
  });
  it("says No data before the first sample and shows why", async () => {
    serve(networkFixtures("healthy", true));
    render(<App />);
    const region = within(await card());
    expect(await region.findByText("No data")).toBeInTheDocument();
    expect(region.getByText("No speed test yet")).toBeInTheDocument();
    expect(await region.findAllByText("No WAN samples in 24 h.")).toHaveLength(2);
    expect(region.getByText("network: ping: connect: Network is unreachable")).toBeInTheDocument();
    expect(region.queryByText("Healthy")).not.toBeInTheDocument();
  });
  it("shows a failed latest test as unknown rates, never the previous numbers", async () => {
    const network = networkFixtures();
    network.status.latest_speed_test = speedTest({
      outcome: "failed",
      started_ms: Date.now() - 5 * 60_000,
      download_bps: null,
      upload_bps: null,
      download_loaded_latency_ms: null,
      upload_loaded_latency_ms: null,
      error: "HTTP 500",
    });
    serve(network);
    render(<App />);
    const region = within(await card());
    expect(await region.findByText("Last test failed 5 min ago")).toBeInTheDocument();
    expect(region.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(region.queryByText(/Mb\/s/)).not.toBeInTheDocument();
  });
  it("refetches on network.sample without blanking the card, then shows the new state", async () => {
    let release: (response: Response) => void = () => {};
    let calls = 0;
    const down = networkFixtures("down").status;
    const fetch = serve(networkFixtures(), (path) => {
      if (path !== "/v1/network" || ++calls === 1) return null;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    render(<App />);
    const region = within(await card());
    expect(await region.findByText("Healthy")).toBeInTheDocument();
    act(() => {
      MockSource.latest.dispatchEvent(
        new MessageEvent("network.sample", {
          data: JSON.stringify({ type: "network.sample", ts_ms: Date.now(), data: [] }),
        }),
      );
    });
    expect(fetch.mock.calls.filter(([path]) => path === "/v1/network")).toHaveLength(2);
    expect(region.getByText("Healthy")).toBeInTheDocument();
    expect(region.queryByLabelText("Loading section")).not.toBeInTheDocument();
    await act(async () => release(new Response(JSON.stringify(down))));
    expect(await region.findByText("Down · WAN")).toBeInTheDocument();
  });
});
