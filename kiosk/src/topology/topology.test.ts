import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EDGES, FLOWS, NODE_H, NODE_W, NODES, ZONES } from "./topology";
import { routesFor } from "./routes";
import TopologyPage from "./topology-map";
import { PHONE } from "../lib/motion";

const ids = (items: { id: string }[]) => items.map((item) => item.id);
const nodeIds = new Set(ids(NODES));
const zoneIds = new Set(ids(ZONES));
const edgeIds = new Set(ids(EDGES));

describe("topology data", () => {
  it("ids are unique and every edge and flow references real nodes, zones and edges", () => {
    for (const list of [NODES, ZONES, EDGES, FLOWS])
      expect(new Set(ids(list)).size).toBe(list.length);
    expect(ids(NODES).some((id) => zoneIds.has(id))).toBe(false);
    for (const edge of EDGES)
      for (const end of [edge.from, edge.to])
        expect(nodeIds.has(end) || zoneIds.has(end), `${edge.id} → ${end}`).toBe(true);
    for (const flow of FLOWS) {
      for (const id of flow.nodes)
        expect(nodeIds.has(id) || zoneIds.has(id), `${flow.id} node ${id}`).toBe(true);
      for (const id of flow.edges) expect(edgeIds.has(id), `${flow.id} edge ${id}`).toBe(true);
      expect(flow.steps.length).toBeGreaterThan(0);
    }
  });

  it("every node sits in exactly one group", () => {
    const groups = ZONES.filter((zone) => zone.tone === "group");
    for (const node of NODES) {
      const containing = groups.filter(
        (zone) =>
          node.x >= zone.x &&
          node.y >= zone.y &&
          node.x + NODE_W <= zone.x + zone.w &&
          node.y + NODE_H <= zone.y + zone.h,
      );
      expect(ids(containing), node.id).toHaveLength(1);
    }
  });
});

describe("routing", () => {
  it("every edge of every flow routes", () => {
    for (const flow of FLOWS) {
      const routes = routesFor(flow);
      expect([...routes.keys()], flow.id).toStrictEqual(flow.edges);
      for (const route of routes.values()) {
        expect(route.d).toMatch(
          /^M[-\d.]+,[-\d.]+( L[-\d.]+,[-\d.]+( Q[-\d.]+,[-\d.]+ [-\d.]+,[-\d.]+)?)+$/,
        );
        expect(route.arrow).toMatch(/^M.* Z$/);
        expect(route.points.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("no route segment crosses a box other than its endpoints", () => {
    const crosses = (a: [number, number], b: [number, number], box: (typeof NODES)[number]) => {
      const left = Math.min(a[0], b[0]);
      const right = Math.max(a[0], b[0]);
      const top = Math.min(a[1], b[1]);
      const bottom = Math.max(a[1], b[1]);
      return right > box.x && left < box.x + NODE_W && bottom > box.y && top < box.y + NODE_H;
    };
    for (const flow of FLOWS) {
      for (const [id, route] of routesFor(flow)) {
        const edge = EDGES.find((candidate) => candidate.id === id)!;
        const others = NODES.filter((node) => node.id !== edge.from && node.id !== edge.to);
        for (let i = 1; i < route.points.length; i++) {
          const a = route.points[i - 1]!;
          const b = route.points[i]!;
          // Segments are orthogonal; the router never produces a diagonal.
          expect(a[0] === b[0] || a[1] === b[1], `${flow.id}/${id} segment ${i}`).toBe(true);
          const hit = others.filter((node) => crosses(a, b, node));
          expect(ids(hit), `${flow.id}/${id} segment ${i}`).toHaveLength(0);
        }
      }
    }
  });
});

describe("topology page", () => {
  beforeEach(() => {
    // React Flow measures nodes with layout APIs jsdom lacks (reactflow.dev/learn/advanced-use/testing).
    vi.stubGlobal(
      "ResizeObserver",
      class {
        callback: (entries: { target: Element; contentRect: DOMRect }[], observer: unknown) => void;
        constructor(callback: typeof this.callback) {
          this.callback = callback;
        }
        observe(target: Element) {
          // Async like the real API: node effects run before the flow registers its DOM node.
          setTimeout(() =>
            this.callback([{ target, contentRect: target.getBoundingClientRect() }], this),
          );
        }
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "DOMMatrixReadOnly",
      class {
        m22: number;
        constructor(transform?: string) {
          const scale = transform?.match(/scale\(([1-9.]+)\)/)?.[1];
          this.m22 = scale === undefined ? 1 : Number(scale);
        }
      },
    );
    Object.defineProperties(HTMLElement.prototype, {
      offsetHeight: {
        configurable: true,
        get(this: HTMLElement) {
          return parseFloat(this.style.height) || 1;
        },
      },
      offsetWidth: {
        configurable: true,
        get(this: HTMLElement) {
          return parseFloat(this.style.width) || 1;
        },
      },
    });
    (SVGElement.prototype as SVGElement & { getBBox: () => DOMRect }).getBBox = () =>
      ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
  });

  const drawnEdges = () => screen.queryAllByRole("img", { name: /^Edge from / });

  it("renders, switching flows changes the drawn edge count, and the popover lists the steps", async () => {
    render(createElement(TopologyPage, { dark: true }));
    expect(screen.getByRole("heading", { name: "Topology" })).toBeInTheDocument();
    const first = FLOWS[0]!;
    expect(screen.getByRole("region", { name: first.name })).toBeInTheDocument();
    expect(screen.getByText("Devon")).toBeInTheDocument();
    expect(screen.getByText("Metacomet tailnet")).toBeInTheDocument();
    await screen.findByRole("img", { name: "Edge from devon to linear" });
    expect(drawnEdges()).toHaveLength(first.edges.length);

    const next = FLOWS.find((flow) => flow.edges.length !== first.edges.length)!;
    fireEvent.click(screen.getByRole("button", { name: next.name }));
    expect(screen.getByRole("button", { name: next.name })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: next.name })).toBeInTheDocument();
    await screen.findByRole("img", {
      name: `Edge from ${EDGES.find((e) => e.id === next.edges[0])!.from} to ${EDGES.find((e) => e.id === next.edges[0])!.to}`,
    });
    expect(drawnEdges()).toHaveLength(next.edges.length);

    const explain = screen.getByRole("button", { name: `How ${next.name.toLowerCase()} works` });
    expect(explain).toHaveAttribute("popovertarget", "topology-steps");
    const steps = document.getElementById("topology-steps")!;
    expect(steps).toHaveAttribute("popover", "auto");
    // jsdom has no popover API, so the closed popover stays display:none; `hidden` reads through it.
    const items = within(steps).getAllByRole("listitem", { hidden: true });
    expect(items.map((item) => item.textContent)).toStrictEqual(next.steps);
    expect(within(steps).getByText("Solid: request or data")).toBeInTheDocument();
  });

  it("shows the steps inline on a phone, in the document flow instead of a popover", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === PHONE,
      addEventListener() {},
      removeEventListener() {},
    }));
    render(createElement(TopologyPage, { dark: true }));
    const first = FLOWS[0]!;
    const explain = screen.getByRole("button", { name: `How ${first.name.toLowerCase()} works` });
    expect(explain).not.toHaveAttribute("popovertarget");
    expect(explain).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("topology-steps")).toBeNull();
    fireEvent.click(explain);
    expect(explain).toHaveAttribute("aria-expanded", "true");
    const steps = screen.getByRole("region", { name: `How ${first.name.toLowerCase()} works` });
    expect(steps).not.toHaveAttribute("popover");
    expect(
      within(steps)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toStrictEqual(first.steps);
  });
});

describe("bundle", () => {
  it("the overview bundle doesn't import @xyflow/react", () => {
    const src = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const packages = new Set<string>();
    const seen = new Set<string>();
    // Static imports only: `import(...)` is a code split, so it does not join the overview chunk.
    const pattern =
      /^\s*(?:import|export)\s+(?!type\b)[^;'"]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm;
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(pattern)) {
        const spec = match[1] ?? match[2]!;
        if (!spec.startsWith(".") && !spec.startsWith("@/")) {
          packages.add(spec);
          continue;
        }
        const base = spec.startsWith("@/")
          ? resolve(src, spec.slice(2))
          : resolve(dirname(file), spec);
        const target = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((candidate) => {
          try {
            return readFileSync(candidate) && !candidate.endsWith(".css");
          } catch {
            return false;
          }
        });
        if (target && /\.tsx?$/.test(target)) walk(target);
      }
    };
    walk(resolve(src, "main.tsx"));
    expect(seen.has(resolve(src, "topology/topology-map.tsx"))).toBe(false);
    expect([...packages].some((spec) => spec.startsWith("@xyflow/"))).toBe(false);
    // Control: the walker does see React Flow when it starts at the topology page.
    seen.clear();
    walk(resolve(src, "topology/topology-map.tsx"));
    expect([...packages].some((spec) => spec.startsWith("@xyflow/"))).toBe(true);
  });
});
