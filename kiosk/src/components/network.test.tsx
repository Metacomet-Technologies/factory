import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { networkFixtures, type NetworkScenario } from "../../mock/network-fixtures";
import type { Resource } from "../api/client";
import { initialLiveState, parseEvent, streamReducer } from "../api/stream";
import type { NetworkEvent } from "../api/types";
import { eventBands, networkBadge } from "../lib/network";
import { NetworkSection } from "./network";
import NetworkPage from "./network-page";

const NOW = 1_800_000_000_000;
const loaded = <T,>(data: T): Resource<T> => ({ data, error: null, loading: false });

beforeEach(() => {
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

describe("network badge", () => {
  it.each([
    ["healthy", "Healthy", "ok"],
    ["loss", "Degraded · wan loss", "warn"],
    ["latency", "Degraded · wan latency", "warn"],
    ["jitter", "Degraded · wan jitter", "warn"],
    ["lan-down", "Down · lan", "fail"],
    ["wan-down", "Down · wan", "fail"],
    ["dns-down", "Down · dns", "fail"],
    ["tailnet-down", "Down · tailnet", "fail"],
    ["unknown", "Unknown", "neutral"],
  ] as [NetworkScenario, string, string][])("%s reads %s", (scenario, label, tone) => {
    expect(networkBadge(networkFixtures(scenario, NOW).status, NOW)).toEqual({ label, tone });
  });

  it("calls a healthy state with only stale samples unknown", () => {
    const { status } = networkFixtures("healthy", NOW);
    expect(networkBadge(status, NOW + 107_000).label).toBe("Healthy");
    expect(networkBadge(status, NOW + 109_000).label).toBe("Unknown");
  });
});

describe("network card", () => {
  const card = (scenario: NetworkScenario, status = networkFixtures(scenario, NOW).status) =>
    render(
      <NetworkSection
        status={loaded(status)}
        history={loaded(networkFixtures(scenario, NOW).history("24h"))}
        now={NOW}
      />,
    );

  it("links to /network with the state, rates and test age", () => {
    card("dns-down");
    const link = screen.getByRole("link", { name: "Network quality details" });
    expect(link.getAttribute("href")).toBe("/network");
    const region = within(link).getByRole("region", { name: "Network" });
    expect(within(region).getByText("Down · dns")).toBeTruthy();
    expect(within(region).getByText("910 Mb/s")).toBeTruthy();
    expect(within(region).getByText("419 Mb/s")).toBeTruthy();
    expect(within(region).getByText("9.6 min ago")).toBeTruthy();
    expect(
      within(region).getByRole("img", {
        name: /WAN latency 24h sparkline, 1\.1\.1\.1 and 8\.8\.8\.8/,
      }),
    ).toBeTruthy();
    expect(within(region).getByRole("img", { name: /WAN loss 24h sparkline/ })).toBeTruthy();
  });

  it("says when no speed test has run and shows the cause of an unknown state", () => {
    card("no-speed-test");
    expect(screen.getByText("None yet")).toBeTruthy();
    expect(screen.getAllByText("—")).toHaveLength(2);
    card("unknown");
    expect(screen.getByText("Unknown")).toBeTruthy();
    expect(screen.getByText("ping failed without a summary")).toBeTruthy();
  });

  it("follows the styleguide loading and error states", () => {
    const history = loaded(networkFixtures("healthy", NOW).history("24h"));
    const { rerender } = render(
      <NetworkSection
        status={{ data: null, error: null, loading: true }}
        history={history}
        now={NOW}
      />,
    );
    expect(screen.getByLabelText("Loading section")).toBeTruthy();
    rerender(
      <NetworkSection
        status={{ data: null, error: "HTTP 503", loading: false }}
        history={history}
        now={NOW}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("HTTP 503");
    expect(screen.getByText("Unknown")).toBeTruthy();
  });
});

describe("event bands", () => {
  const event = (id: number, layer: "wan" | "dns", started_ms: number, ended_ms: number | null) =>
    ({ id, state: "down", layer, started_ms, ended_ms }) as NetworkEvent;

  it("clips episodes of the layer to the visible range and runs open ones to now", () => {
    const from = NOW - 3_600_000;
    const bands = eventBands(
      [
        event(1, "wan", NOW - 600_000, null),
        event(2, "wan", from - 120_000, from + 60_000),
        event(3, "wan", from - 300_000, from - 1),
        event(4, "dns", NOW - 600_000, NOW - 300_000),
      ],
      "wan",
      from,
      NOW,
    );
    expect(bands).toEqual([
      { id: 1, x1: NOW - 600_000, x2: NOW, tone: "fail" },
      { id: 2, x1: from, x2: from + 60_000, tone: "fail" },
    ]);
  });
});

describe("/network page", () => {
  function api(scenario: NetworkScenario) {
    const fixtures = networkFixtures(scenario, Date.now());
    const fetch = vi.fn((path: string) => {
      const url = new URL(path, "http://localhost");
      const range = url.searchParams.get("range") ?? "24h";
      const before = url.searchParams.get("before");
      const body =
        url.pathname === "/v1/network/history"
          ? fixtures.history(range as "24h")
          : url.pathname === "/v1/network/speed-tests"
            ? fixtures.speed(range)
            : fixtures.eventPage(
                before == null ? null : Number(before),
                Number(url.searchParams.get("limit")),
              );
      return Promise.resolve(new Response(JSON.stringify(body)));
    });
    vi.stubGlobal("fetch", fetch);
    render(
      <NetworkPage
        status={loaded(fixtures.status)}
        now={Date.now()}
        revision={0}
        speedRevision={0}
      />,
    );
    return fetch;
  }
  const calls = (fetch: ReturnType<typeof api>) => fetch.mock.calls.map(([path]) => String(path));

  it("switches every range and asks speed tests for 24h when showing 1h", async () => {
    const fetch = api("healthy");
    await screen.findByText("Recent speed tests");
    for (const range of ["1h", "7d", "30d", "24h"]) {
      fireEvent.click(screen.getByRole("button", { name: range }));
      await waitFor(() => expect(calls(fetch)).toContain(`/v1/network/history?range=${range}`));
      expect(screen.getByRole("button", { name: range }).getAttribute("aria-pressed")).toBe("true");
    }
    expect(calls(fetch)).toContain("/v1/network/speed-tests?range=24h");
    expect(calls(fetch)).toContain("/v1/network/speed-tests?range=30d");
    expect(calls(fetch)).not.toContain("/v1/network/speed-tests?range=1h");
  });

  it("pages events with before/next_before and marks the open one ongoing", async () => {
    const fetch = api("wan-down");
    const events = await screen.findByRole("region", { name: "Network events" });
    await within(events).findByText("7 min · ongoing");
    expect(within(events).getAllByRole("row")).toHaveLength(21);
    fireEvent.click(within(events).getByRole("button", { name: "Older events" }));
    // The first page holds the open event (101) and closed ids 100–82.
    await waitFor(() => expect(calls(fetch)).toContain("/v1/network/events?limit=20&before=82"));
    await waitFor(() => expect(within(events).queryByText("7 min · ongoing")).toBeNull());
    fireEvent.click(within(events).getByRole("button", { name: "Older events" }));
    await waitFor(() => expect(within(events).getAllByRole("row")).toHaveLength(7));
    expect(within(events).queryByRole("button", { name: "Older events" })).toBeNull();
    fireEvent.click(within(events).getByRole("button", { name: "Newest events" }));
    await within(events).findByText("7 min · ongoing");
  });

  it("shows an empty events table", async () => {
    api("empty-events");
    expect(await screen.findByText("No network events.")).toBeTruthy();
  });

  it("shows an empty speed-test table", async () => {
    api("no-speed-test");
    const tests = await screen.findByRole("region", { name: "Recent speed tests" });
    expect(await within(tests).findByText("No speed tests in this range.")).toBeTruthy();
  });
});

it("turns network SSE frames into refetch revisions and rejects malformed ones", () => {
  const sample = parseEvent({ type: "network.sample", ts_ms: NOW, data: [] });
  const test = parseEvent({
    type: "network.speedtest",
    ts_ms: NOW,
    data: { id: 1, started_ms: NOW, ended_ms: NOW, outcome: "ok" },
  });
  expect(parseEvent({ type: "network.sample", ts_ms: NOW, data: {} })).toBeNull();
  expect(parseEvent({ type: "network.speedtest", ts_ms: NOW, data: { id: 1 } })).toBeNull();
  const state = streamReducer(streamReducer(initialLiveState, sample!), test!);
  expect([state.networkRevision, state.speedTestRevision]).toEqual([1, 1]);
});
