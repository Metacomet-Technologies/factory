import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

describe("network page", () => {
  const open = async () => {
    window.history.replaceState(null, "", "/network");
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Network · Latency, loss & throughput" }),
    ).toBeInTheDocument();
  };
  it("routes /network and fetches each range, charting 1 h with a day of speed tests", async () => {
    const fetch = serve(networkFixtures("down"));
    await open();
    expect(
      await within(screen.getByRole("region", { name: "Live network" })).findByText("Down · WAN"),
    ).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("network");
    for (const [range, speed] of [
      ["1h", "24h"],
      ["7d", "7d"],
      ["30d", "30d"],
      ["24h", "24h"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: range }));
      await waitFor(() =>
        expect(fetch).toHaveBeenCalledWith(`/v1/network/history?range=${range}`, expect.anything()),
      );
      expect(fetch).toHaveBeenCalledWith(
        `/v1/network/speed-tests?range=${speed}`,
        expect.anything(),
      );
      expect(screen.getByRole("button", { name: range })).toHaveAttribute("aria-pressed", "true");
    }
    expect(await screen.findByRole("region", { name: "WAN latency and loss" })).toHaveTextContent(
      "1.1.1.1 solid · 8.8.8.8 dashed",
    );
  });
  it("lists events with layer, duration, peak loss and peak jitter, including the open one", async () => {
    serve(networkFixtures("down"));
    await open();
    const events = within(screen.getByRole("region", { name: "Network events" }));
    const rows = await events.findAllByRole("row");
    expect(rows[1]).toHaveTextContent(/DownWAN3 min · ongoing100%——Ongoing/);
    expect(rows[2]).toHaveTextContent(/DownWAN5 min100%——Recovered/);
    expect(rows[3]).toHaveTextContent(/Degraded · lossLAN20 min30%——Recovered/);
    expect(rows[4]).toHaveTextContent(/Degraded · latencyDNS1 h0%312 ms48 msAPI restarted/);
  });
  it("lists the newest speed tests with failures and their errors", async () => {
    serve(networkFixtures("healthy", false, "24h", "24h"));
    await open();
    const tests = within(screen.getByRole("region", { name: "Speed tests" }));
    expect(await tests.findByText("Newest 8 of 8 in the last 24h")).toBeInTheDocument();
    const rows = tests.getAllByRole("row");
    expect(rows[1]).toHaveTextContent(/timeout——9.1 ms— \/ —test exceeded 60 s/);
    expect(tests.getByText("HTTP 500 from speed endpoint").closest("tr")).toHaveTextContent(
      /failed——/,
    );
    expect(tests.getAllByText("ok")).toHaveLength(6);
  });
  it("pages older events and returns to the newest page", async () => {
    const network = networkFixtures();
    const fetch = serve(network, (path) =>
      path === "/v1/network/events?limit=20"
        ? json({ events: network.events.slice(0, 1), next_before: 3 })
        : null,
    );
    await open();
    const events = within(screen.getByRole("region", { name: "Network events" }));
    fireEvent.click(await events.findByRole("button", { name: "Older events" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/v1/network/events?limit=20&before=3", expect.anything()),
    );
    fireEvent.click(await events.findByRole("button", { name: "Newest events" }));
    expect(await events.findByRole("button", { name: "Older events" })).toBeInTheDocument();
  });
  it("shows skeletons while history and events are pending", async () => {
    serve(networkFixtures(), (path) =>
      path.startsWith("/v1/network/history") || path === "/v1/network/events?limit=20"
        ? new Promise(() => {})
        : null,
    );
    await open();
    for (const name of ["Network history", "Network events"])
      expect(
        within(screen.getByRole("region", { name })).getByLabelText("Loading section"),
      ).toBeInTheDocument();
    expect(screen.queryByText(/Loading .*…/)).not.toBeInTheDocument();
  });
  it("shows empty states before any sample, test or event exists", async () => {
    serve(networkFixtures("healthy", true));
    await open();
    expect(await screen.findAllByText("No samples in this range.")).toHaveLength(4);
    expect(await screen.findByText("No network events.")).toBeInTheDocument();
    expect(screen.getAllByText("No speed tests in this range.")).toHaveLength(2);
    expect(screen.getAllByText("No sample yet")).toHaveLength(5);
    expect(
      within(screen.getByRole("region", { name: "Live network" })).getByText("No data"),
    ).toBeInTheDocument();
  });
  it("keeps each failed request visible without hiding the rest of the page", async () => {
    serve(networkFixtures("healthy", false, "24h", "24h"), (path) =>
      path.startsWith("/v1/network/history") || path.startsWith("/v1/network/events")
        ? json({}, 503)
        : null,
    );
    await open();
    const history = screen.getByRole("region", { name: "Network history" });
    await waitFor(() => expect(within(history).getAllByRole("alert")).toHaveLength(2));
    const [historyAlert, bandsAlert] = within(history).getAllByRole("alert");
    expect(historyAlert).toHaveTextContent("Unable to load history");
    expect(historyAlert).toHaveTextContent("HTTP 503");
    expect(bandsAlert).toHaveTextContent("Event bands unavailable");
    expect(
      within(screen.getByRole("region", { name: "Network events" })).getByRole("alert"),
    ).toHaveTextContent("HTTP 503");
    expect(
      within(screen.getByRole("region", { name: "Live network" })).getByText("Healthy"),
    ).toBeInTheDocument();
    expect(await screen.findByText("Newest 8 of 8 in the last 24h")).toBeInTheDocument();
  });
});
