import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Page } from "@playwright/test";
import type { components } from "../src/api/generated.ts";

// Drives only this worktree's synthetic sandbox: its .sandbox fixture files and loopback API.
const root = new URL("../../", import.meta.url);
const ports = JSON.parse(await readFile(new URL(".sandbox/ports.json", root), "utf8")) as {
  "factory-api": number;
};
const origin = `http://127.0.0.1:${ports["factory-api"]}`;
const artifacts = process.env.NETWORK_CHECK_ARTIFACTS
  ? pathToFileURL(`${resolve(process.env.NETWORK_CHECK_ARTIFACTS)}/`)
  : new URL(".amp/in/artifacts/", root);
const prefix = process.env.NETWORK_CHECK_PREFIX ?? "network-";
await mkdir(artifacts, { recursive: true });
process.env.PLAYWRIGHT_BROWSERS_PATH ??= `${process.cwd()}/.browsers`;
const { chromium, expect } = await import("@playwright/test");

type Status = components["schemas"]["NetworkStatus"];
/** Badge text each ping fixture must reach, from docs/sandbox.md "Network fakes". */
const pings = [
  ["healthy", "Healthy"],
  ["loss", "Degraded · WAN loss"],
  ["wan-down", "Down · WAN"],
  ["lan-down", "Down · LAN"],
] as const;
/** Outcome each speed fixture must store. */
const speeds = [
  ["ok", "ok"],
  ["slow", "ok"],
  ["fail", "failed"],
] as const;
const ranges = ["1h", "24h", "7d", "30d"] as const;
const layers = ["LAN", "WAN", "DNS", "Tailnet"] as const;

const fixture = (name: "network-ping" | "network-speed", value: string) =>
  writeFile(new URL(`.sandbox/${name}`, root), `${value}\n`);
const status = async () => (await (await fetch(`${origin}/v1/network`)).json()) as Status;
const label = (state: Status["state"]) => {
  const layer =
    state.state === "healthy"
      ? ""
      : { lan: "LAN", wan: "WAN", dns: "DNS", tailnet: "Tailnet" }[state.layer];
  return state.state === "healthy"
    ? "Healthy"
    : state.state === "down"
      ? `Down · ${layer}`
      : `Degraded · ${layer} ${state.reason}`;
};
async function until<T>(what: string, timeout: number, probe: () => Promise<T | undefined>) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 2_000));
  }
}
/** Waits for a tick that started after the change and diagnosed the expected state. */
const reach = (expected: string, after: number) =>
  until(`network state ${expected}`, 180_000, async () => {
    const now = await status();
    const newest = Math.max(...now.targets.map((target) => target.latest?.ts_ms ?? 0));
    return newest > after && label(now.state) === expected ? now : undefined;
  });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1728, height: 1117 },
  colorScheme: "dark",
  timezoneId: "America/New_York",
});
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const reports: unknown[] = [];
const file = (name: string) => fileURLToPath(new URL(`${prefix}${name}.png`, artifacts));

/** No document or main-area scroll, the grid above the footer, and no panel content outside its panel. */
const layout = (target: Page) =>
  target.evaluate(() => {
    const document_ = document.scrollingElement!;
    const main = document.querySelector("main")!;
    const grid = document.querySelector(".dashboard-grid");
    const panels = [...document.querySelectorAll<HTMLElement>("section.panel")];
    const outside = panels.flatMap((panel) => {
      const box = panel.getBoundingClientRect();
      return [...panel.querySelectorAll<HTMLElement>("*")]
        .filter((element) => {
          if (element.closest(".recharts-tooltip-wrapper")) return false;
          if (getComputedStyle(element).visibility === "hidden") return false;
          const rect = element.getBoundingClientRect();
          return (
            rect.width > 0 &&
            (rect.left < box.left - 1 ||
              rect.right > box.right + 1 ||
              rect.top < box.top - 1 ||
              rect.bottom > box.bottom + 1)
          );
        })
        .map((element) => `${panel.getAttribute("aria-label")}: ${element.tagName.toLowerCase()}`);
    });
    const truncated = panels.flatMap((panel) =>
      [...panel.querySelectorAll<HTMLElement>("*")]
        .filter(
          (element) =>
            getComputedStyle(element).overflowX === "hidden" &&
            element.scrollWidth > element.clientWidth + 1,
        )
        .map((element) => `${panel.getAttribute("aria-label")}: ${element.textContent}`),
    );
    return {
      scrollHeight: document_.scrollHeight,
      innerHeight,
      scrollWidth: document_.scrollWidth,
      innerWidth,
      mainScrollHeight: main.scrollHeight,
      mainClientHeight: main.clientHeight,
      mainScrollWidth: main.scrollWidth,
      mainClientWidth: main.clientWidth,
      gridBottom: grid ? Math.round(grid.getBoundingClientRect().bottom) : null,
      footerTop: Math.round(document.querySelector("footer")!.getBoundingClientRect().top),
      panels: panels.map((panel) => ({
        name: panel.getAttribute("aria-label"),
        height: Math.round(panel.getBoundingClientRect().height),
        overflowX: panel.scrollWidth - panel.clientWidth,
        overflowY: panel.scrollHeight - panel.clientHeight,
      })),
      outside,
      truncated,
    };
  });
/** Grows the viewport to the scrolling main area so the capture holds the whole page. */
async function capture(name: string) {
  const viewport = page.viewportSize()!;
  const height = await page.evaluate(
    () =>
      document.querySelector<HTMLElement>(".topbar")!.offsetHeight +
      document.querySelector("main")!.scrollHeight +
      document.querySelector<HTMLElement>("footer")!.offsetHeight,
  );
  await page.setViewportSize({ width: viewport.width, height: Math.max(height, viewport.height) });
  await page.waitForTimeout(1_200);
  await page.screenshot({ path: file(name), animations: "disabled" });
  await page.setViewportSize(viewport);
}
async function dashboard(name: string, badge: string) {
  for (const theme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`${origin}/`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const card = page.getByRole("region", { name: "Network", exact: true });
    await expect(card).toContainText(badge, { timeout: 20_000 });
    await expect(card.locator(".recharts-surface")).toHaveCount(2, { timeout: 20_000 });
    await page.waitForTimeout(1_500);
    const fit = await layout(page);
    expect(fit.scrollHeight).toBeLessThanOrEqual(fit.innerHeight);
    expect(fit.scrollWidth).toBeLessThanOrEqual(fit.innerWidth);
    expect(fit.mainScrollHeight).toBeLessThanOrEqual(fit.mainClientHeight);
    expect(fit.mainScrollWidth).toBeLessThanOrEqual(fit.mainClientWidth);
    expect(fit.gridBottom!).toBeLessThanOrEqual(fit.footerTop);
    expect(fit.outside).toEqual([]);
    expect(fit.panels.filter((panel) => panel.overflowX > 0 || panel.overflowY > 0)).toEqual([]);
    expect(fit.truncated.filter((text) => text.startsWith("Network:"))).toEqual([]);
    await page.screenshot({ path: file(`dashboard-${name}-${theme}`), animations: "disabled" });
    reports.push({ shot: `dashboard-${name}-${theme}`, badge, card: await card.innerText(), fit });
  }
  await page.emulateMedia({ colorScheme: "dark" });
}
/** Captures /network in each range and returns the shaded band count per layer chart. */
async function networkPage(name: string, badge: string, only: readonly string[] = ranges) {
  const counts: Record<string, Record<string, number>> = {};
  await page.goto(`${origin}/network`);
  await expect(page.getByRole("region", { name: "Live network" })).toContainText(badge, {
    timeout: 20_000,
  });
  for (const range of only) {
    const history = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/v1/network/history" &&
        new URL(response.url()).searchParams.get("range") === range,
    );
    const button = page.getByRole("button", { name: range, exact: true });
    if ((await button.getAttribute("aria-pressed")) === "true") await page.reload();
    else await button.click();
    expect((await history).ok()).toBe(true);
    await expect(page.getByRole("button", { name: range, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator(".network-chart .recharts-surface")).toHaveCount(9, {
      timeout: 20_000,
    });
    await page.waitForTimeout(1_500);
    const bands = Object.fromEntries(
      await Promise.all(
        layers.map(async (layer) => [
          layer,
          await page
            .getByLabel(`${layer} latency history`)
            .locator(".recharts-reference-area")
            .count(),
        ]),
      ),
    );
    const fit = await layout(page);
    expect(fit.scrollWidth).toBeLessThanOrEqual(fit.innerWidth);
    expect(fit.mainScrollWidth).toBeLessThanOrEqual(fit.mainClientWidth);
    await capture(`page-${name}-${range}`);
    counts[range] = bands;
    reports.push({
      shot: `page-${name}-${range}`,
      badge,
      bands,
      live: await page.getByRole("region", { name: "Live network" }).innerText(),
      events: await page.getByRole("region", { name: "Network events" }).innerText(),
    });
  }
  return counts;
}

try {
  await fixture("network-ping", "healthy");
  await fixture("network-speed", "ok");
  for (const [mode, badge] of pings) {
    const changed = Date.now();
    await fixture("network-ping", mode);
    const reached = await reach(badge, changed);
    reports.push({ ping: mode, state: reached.state, open_event: reached.open_event });
    await dashboard(mode, badge);
    const bands = await networkPage(mode, badge);
    if (mode === "loss" || mode === "wan-down") expect(bands["1h"]!.WAN).toBeGreaterThan(0);
    if (mode === "lan-down") expect(bands["1h"]!.LAN).toBeGreaterThan(0);
  }
  await fixture("network-ping", "healthy");
  await reach("Healthy", Date.now());
  for (const [mode, outcome] of speeds) {
    const changed = Date.now();
    await fixture("network-speed", mode);
    const test = await until(`a ${mode} speed test`, 330_000, async () => {
      const latest = (await status()).latest_speed_test;
      return latest && latest.started_ms > changed ? latest : undefined;
    });
    expect(test.outcome).toBe(outcome);
    await dashboard(`speed-${mode}`, "Healthy");
    await networkPage(`speed-${mode}`, "Healthy", ["24h"]);
    const row = await page
      .getByRole("region", { name: "Speed tests" })
      .getByRole("row")
      .nth(1)
      .innerText();
    expect(row).toContain(outcome);
    reports.push({ speed: mode, test, row });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/network`);
  await expect(page.locator(".network-chart .recharts-surface")).toHaveCount(9, {
    timeout: 20_000,
  });
  await page.waitForTimeout(1_500);
  const phone = await layout(page);
  expect(phone.scrollWidth).toBeLessThanOrEqual(phone.innerWidth);
  expect(phone.mainScrollWidth).toBeLessThanOrEqual(phone.mainClientWidth);
  await capture("page-390-dark");
  reports.push({ shot: "page-390-dark", fit: phone });
  expect(errors).toEqual([]);
} finally {
  await fixture("network-ping", "healthy");
  await fixture("network-speed", "ok");
  await writeFile(
    new URL(`${prefix}check.json`, artifacts),
    JSON.stringify({ origin, reports, errors }, null, 2),
  );
  await browser.close();
}
console.log(JSON.stringify({ origin, shots: reports.length, errors }, null, 2));
