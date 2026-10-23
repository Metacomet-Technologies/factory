import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import App from "./App";
import { fixtures } from "../mock/fixtures";
import { siteFixtures } from "../mock/site-fixtures";

class MockSource extends EventTarget {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  close() {}
}
beforeEach(() => {
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

/** Each details page, the requests that feed it, and the regions that must show the state. */
const pages = [
  {
    path: "/ups",
    owns: (path: string) => /^\/v1\/(ups\/|settings\/ups)/.test(path),
    regions: ["UPS history", "Power events", "Energy", "UPS settings"],
  },
  {
    path: "/llm",
    owns: (path: string) => /^\/v1\/(llm\/usage|pricing)/.test(path),
    regions: ["Totals"],
  },
  {
    path: "/network",
    owns: (path: string) => path.startsWith("/v1/network"),
    regions: ["Live network", "Network history", "Network events", "Speed tests"],
  },
  {
    path: "/devices/factory-gpu",
    owns: (path: string) => path.startsWith("/v1/devices/factory-gpu"),
    regions: [],
  },
] as const;

function serve(owns: (path: string) => boolean, answer: () => Promise<Response>) {
  const data = fixtures();
  const routes: Record<string, unknown> = {
    "/v1/health": data.health,
    "/v1/fleet": data.fleet,
    "/v1/gpu": data.gpu,
    "/v1/ups": { generated_at_ms: Date.now(), current: null, warnings: [] },
    "/v1/agents": data.agents,
    "/v1/devices": { generated_at_ms: Date.now(), devices: [] },
    "/v1/devices/factory-gpu": siteFixtures().deviceView,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string) => {
      if (owns(path)) return answer();
      if (path.startsWith("/control/")) return Promise.resolve(new Response("{}", { status: 403 }));
      const url = new URL(path, "http://localhost");
      return Promise.resolve(new Response(JSON.stringify(routes[url.pathname] ?? null)));
    }),
  );
}

describe.each(pages)("$path", ({ path, owns, regions }) => {
  const scopes = () =>
    regions.length
      ? regions.map((name) => within(screen.getByRole("region", { name })))
      : [within(screen.getByRole("main"))];

  it("shows skeletons, not loading text, while its data is pending", async () => {
    serve(owns, () => new Promise(() => {}));
    window.history.replaceState(null, "", path);
    render(<App />);
    await screen.findByRole("main");
    await waitFor(() => {
      for (const scope of scopes())
        expect(scope.getAllByLabelText("Loading section").length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/Loading\b.*…/)).not.toBeInTheDocument();
  });

  it("shows the destructive Alert when its data fails", async () => {
    serve(owns, () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: "x", message: "HTTP 503" } }), {
          status: 503,
        }),
      ),
    );
    window.history.replaceState(null, "", path);
    render(<App />);
    await screen.findByRole("main");
    await waitFor(() => {
      for (const scope of scopes()) {
        const alert = scope.getAllByRole("alert")[0]!;
        expect(alert).toHaveAttribute("data-slot", "alert");
        expect(alert).toHaveTextContent("Retrying on the next refresh.");
      }
      // Lazy chart chunks may show their skeleton for a moment; nothing stays loading.
      expect(screen.queryByLabelText("Loading section")).not.toBeInTheDocument();
    });
  });
});

describe("states a page owns only in part", () => {
  const pending = () => new Promise<Response>(() => {});
  const failed = () =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { code: "x", message: "HTTP 503" } }), {
        status: 503,
      }),
    );
  async function open(
    path: string,
    owns: (path: string) => boolean,
    answer: () => Promise<Response>,
  ) {
    serve(owns, answer);
    window.history.replaceState(null, "", path);
    render(<App />);
    await screen.findByRole("main");
  }

  it("shows a skeleton in Battery health while only the self-test history is pending", async () => {
    // limit=200 is the self-test/outage history; limit=20 is the timeline, which answers.
    await open("/ups", (path) => path.startsWith("/v1/ups/events?limit=200"), pending);
    const health = screen.getByRole("region", { name: "Battery health" });
    await waitFor(() =>
      expect(within(health).getByLabelText("Loading section")).toBeInTheDocument(),
    );
    expect(
      within(screen.getByRole("region", { name: "Power events" })).queryByLabelText(
        "Loading section",
      ),
    ).toBeNull();
  });

  it("shows the self-test history failure in Battery health", async () => {
    await open("/ups", (path) => path.startsWith("/v1/ups/events?limit=200"), failed);
    const health = screen.getByRole("region", { name: "Battery health" });
    const alert = await within(health).findByRole("alert");
    expect(alert).toHaveTextContent("Unable to load the self-test history");
    expect(within(alert).getByText("Event history: HTTP 503")).toBeInTheDocument();
  });

  it.each([
    ["pending", pending, "Loading section"],
    ["failed", failed, null],
  ] as const)(
    "shows the /v1/ups request state in Live UPS when %s",
    async (_name, answer, label) => {
      await open("/ups", (path) => path === "/v1/ups", answer);
      const live = screen.getByRole("region", { name: "Live UPS" });
      if (label)
        await waitFor(() => expect(within(live).getByLabelText(label)).toBeInTheDocument());
      else
        expect(
          within(await within(live).findByRole("alert")).getByText("HTTP 503"),
        ).toBeInTheDocument();
    },
  );

  it.each([
    ["pending", pending],
    ["failed", failed],
  ] as const)(
    "shows the CPU history state, not an empty chart, when history is %s",
    async (name, answer) => {
      await open(
        "/devices/factory-gpu",
        (path) => path.startsWith("/v1/devices/factory-gpu/history"),
        answer,
      );
      const history = await screen.findByRole("region", { name: "CPU history" });
      if (name === "pending")
        expect(within(history).getByLabelText("Loading section")).toBeInTheDocument();
      else
        expect(
          within(await within(history).findByRole("alert")).getByText("HTTP 503"),
        ).toBeInTheDocument();
      expect(within(history).queryByText("No samples in this range.")).toBeNull();
    },
  );
});
