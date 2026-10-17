import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { networkFixtures } from "../mock/network-fixtures.ts";

// Drives a running kiosk (default: `vp run mock-dev`) with populated mock fixtures.
// Routes are intercepted only for the loading, error and asymmetric-history cases.
const origin = process.env.KIOSK_URL ?? "http://127.0.0.1:4181";
const artifacts = new URL("../../.amp/in/artifacts/met-218/", import.meta.url);
await mkdir(artifacts, { recursive: true });
process.env.PLAYWRIGHT_BROWSERS_PATH ??= `${process.cwd()}/.browsers`;
const { chromium, expect } = await import("@playwright/test");
const browser = await chromium.launch();
const errors: string[] = [];
// Trusted main served from the same populated mock fixtures, e.g. an `origin/main` export
// running `vp run mock-dev` on other ports. Existing cards must keep their exact boxes.
const baselineUrl = process.env.BASELINE_URL;
const moved: string[] = [];
let baseline: { name: string | null; x: number; y: number; width: number; height: number }[] = [];
const reports: Record<string, unknown> = {};

async function open(path: string, theme: "dark" | "light", width = 1728, height = 1117) {
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme });
  page.on("pageerror", (error) => errors.push(`${path} ${theme} ${width}: ${error.message}`));
  return page;
}
type Page = Awaited<ReturnType<typeof open>>;

/** The dashboard must fit the kiosk display: no scroll inside main, no horizontal overflow. */
async function fits(page: Page, label: string) {
  const layout = await page.evaluate(() => {
    const main = document.querySelector("main")!;
    const panels = [...document.querySelectorAll("main section.panel")].map((panel) => {
      const box = panel.getBoundingClientRect();
      return {
        name: panel.getAttribute("aria-label"),
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
        right: Math.round(box.right),
        bottom: Math.round(box.bottom),
      };
    });
    return {
      overflowY: main.scrollHeight - main.clientHeight,
      overflowX: Math.max(
        main.scrollWidth - main.clientWidth,
        document.documentElement.scrollWidth - window.innerWidth,
      ),
      mainBottom: Math.round(main.getBoundingClientRect().bottom),
      panels,
    };
  });
  expect(layout.overflowY, `${label}: vertical overflow`).toBeLessThanOrEqual(0);
  expect(layout.overflowX, `${label}: horizontal overflow`).toBeLessThanOrEqual(0);
  const network = layout.panels.find((panel) => panel.name === "Network");
  expect(network, `${label}: Network card rendered`).toBeTruthy();
  expect(network!.bottom).toBeLessThanOrEqual(layout.mainBottom);
  for (const [i, a] of layout.panels.entries())
    for (const b of layout.panels.slice(i + 1))
      expect(
        a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y,
        `${label}: ${a.name} overlaps ${b.name}`,
      ).toBe(true);
  reports[label] = layout;
  for (const before of baseline) {
    const after = layout.panels.find((panel) => panel.name === before.name);
    const same =
      after &&
      (["x", "y", "width", "height"] as const).every(
        (key) => Math.abs(after[key] - before[key]) <= 1,
      );
    if (!same)
      moved.push(
        `${label}: ${before.name} main ${JSON.stringify(before)} branch ${JSON.stringify(after)}`,
      );
  }
}

const shot = (page: Page, name: string) =>
  page.screenshot({
    path: fileURLToPath(new URL(`${name}.png`, artifacts)),
    animations: "disabled",
  });

try {
  if (baselineUrl) {
    const page = await open("/", "dark");
    await page.goto(baselineUrl);
    await expect(page.getByRole("region", { name: "Local LLM" })).toBeVisible();
    await page.waitForTimeout(2500);
    baseline = await page.evaluate(() =>
      [...document.querySelectorAll("main section.panel")].map((panel) => {
        const box = panel.getBoundingClientRect();
        return {
          name: panel.getAttribute("aria-label"),
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height),
        };
      }),
    );
    reports.baseline = baseline;
    await page.close();
  }
  for (const theme of ["dark", "light"] as const) {
    const page = await open("/", theme);
    await page.goto(origin);
    const card = page.getByRole("link", { name: "Network quality details" });
    await expect(card).toHaveAttribute("href", "/network");
    await expect(card.getByText("Mb/s").first()).toBeVisible();
    await page.waitForTimeout(1200);
    await fits(page, `dashboard loaded ${theme}`);
    await shot(page, `dashboard-1728x1117-${theme}`);
    await page.close();
  }

  // Loading: /v1/network never answers. Error: it answers 503.
  for (const state of ["loading", "error"] as const) {
    const page = await open("/", "dark");
    await page.route("**/v1/network", (route) =>
      state === "error" ? route.fulfill({ status: 503, body: "{}" }) : undefined,
    );
    await page.goto(origin);
    const card = page.getByRole("region", { name: "Network" });
    await expect(
      state === "error" ? card.getByRole("alert") : card.getByLabel("Loading section"),
    ).toBeVisible();
    await page.waitForTimeout(1200);
    await fits(page, `dashboard ${state}`);
    await shot(page, `dashboard-1728x1117-${state}`);
    await page.close();
  }

  // Raw buckets start at each target's first probe, so wan targets need not share timestamps.
  // Target A: 0 and 150 s. Target B: 30 s and 180 s, then an explicit null RTT, then 330–360 s.
  const now = Date.now();
  const base = now - 30 * 60_000;
  const point = (offset: number, avg: number | null, loss: number) => ({
    ts_ms: base + offset,
    sample_count: 1,
    loss_percent: loss,
    jitter_ms: 1,
    latency_ms: { min: avg, avg, max: avg },
  });
  const history = {
    ...networkFixtures("healthy", now).history("1h"),
    series: [
      { layer: "wan", target: "A", points: [point(0, 10, 0), point(150_000, 12, 5)] },
      {
        layer: "wan",
        target: "B",
        points: [
          point(30_000, 20, 0),
          point(180_000, 22, 10),
          point(240_000, null, 100),
          point(330_000, 24, 0),
          point(360_000, 26, 0),
        ],
      },
    ],
  };
  const page = await open("/network", "dark");
  await page.route("**/v1/network/history?range=1h", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(history) }),
  );
  await page.goto(`${origin}/network`);
  await page.getByRole("button", { name: "1h", exact: true }).click();
  const chart = page.getByLabel("wan latency and loss history");
  await expect(chart.locator("path.recharts-line-curve")).toHaveCount(4);
  await page.waitForTimeout(1500);
  const curves = await chart.locator("path.recharts-line-curve").evaluateAll((paths) =>
    paths.map((path) => {
      const d = path.getAttribute("d") ?? "";
      return {
        stroke: path.getAttribute("stroke"),
        segments: (d.match(/M/g) ?? []).length,
        vertices: (d.match(/[ML]/g) ?? []).length,
      };
    }),
  );
  reports.wanCurves = curves;
  // Lines render in declaration order: latency A, latency B, then loss A, loss B.
  const [latencyA, latencyB, lossA, lossB] = curves;
  // Every target keeps its own line; B's null RTT is a gap, not a bridged segment.
  expect(latencyA).toMatchObject({ segments: 1 });
  expect(latencyA!.vertices).toBeGreaterThanOrEqual(2);
  expect(latencyB).toMatchObject({ segments: 2 });
  expect(latencyB!.vertices).toBeGreaterThanOrEqual(4);
  for (const loss of [lossA!, lossB!]) {
    expect(loss.segments).toBe(1);
    expect(loss.vertices).toBeGreaterThanOrEqual(2);
  }
  await page.close();

  for (const theme of ["dark", "light"] as const)
    for (const [width, height] of [
      [1728, 1117],
      [1024, 1366],
      [390, 844],
    ] as const) {
      const network = await open("/network", theme, width, height);
      await network.goto(`${origin}/network`);
      await expect(network.getByRole("region", { name: "Network events" })).toBeVisible();
      await expect(network.locator(".recharts-surface").first()).toBeVisible();
      await network.waitForTimeout(1500);
      const overflowX = await network.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflowX, `/network ${width} ${theme}: horizontal overflow`).toBeLessThanOrEqual(0);
      await shot(network, `network-${width}x${height}-${theme}`);
      await network.close();
    }
  expect(errors).toEqual([]);
  expect(moved, "existing cards moved relative to main").toEqual([]);
} finally {
  await writeFile(
    new URL("network-checks.json", artifacts),
    JSON.stringify({ origin, baselineUrl, errors, moved, reports }, null, 2),
  );
  await browser.close();
}
