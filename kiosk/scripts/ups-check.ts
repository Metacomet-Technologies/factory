import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { fixtures } from "../mock/fixtures.ts";
import type { components } from "../src/api/generated.ts";

// This check writes only the worktree's synthetic sandbox, never a supplied URL.
const root = new URL("../../", import.meta.url);
const ports = JSON.parse(await readFile(new URL(".sandbox/ports.json", root), "utf8")) as {
  "factory-api": number;
};
const origin = `http://127.0.0.1:${ports["factory-api"]}`;
const artifacts = new URL(".amp/in/artifacts/", root);
await mkdir(artifacts, { recursive: true });
process.env.PLAYWRIGHT_BROWSERS_PATH ??= `${process.cwd()}/.browsers`;
const { chromium, expect } = await import("@playwright/test");
const browser = await chromium.launch();
const errors: string[] = [];
const reports: unknown[] = [];
const page = await browser.newPage({
  viewport: { width: 1728, height: 1117 },
  colorScheme: "dark",
  timezoneId: "America/New_York",
});
page.on("pageerror", (error) => errors.push(error.message));
const mode = (value: string) => writeFile(new URL(".sandbox/ups-status", root), `${value}\n`);
const screenshot = (name: string) =>
  page.screenshot({
    path: fileURLToPath(new URL(name, artifacts)),
    fullPage: true,
    animations: "disabled",
  });
try {
  await mode("OL");
  await page.goto(`${origin}/ups`);
  await expect(page.getByRole("heading", { name: "UPS · Power & battery" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Live UPS" })).toContainText("Online", {
    timeout: 20_000,
  });
  await page.getByLabel("Electricity rate · USD per kWh").fill("0.123456");
  await page.getByLabel("Battery installed date").fill("2024-02-29");
  const put = page.waitForResponse(
    (response) =>
      response.url().endsWith("/v1/settings/ups") && response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save settings" }).click();
  expect((await put).request().postDataJSON()).toEqual({
    electricity_rate_micro_usd_per_kwh: 123456,
    battery_installed_ms: 1709164800000,
  });
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await mode("OB DISCHRG");
  const live = page.getByRole("region", { name: "Live UPS" });
  await expect(live).toContainText("On battery", { timeout: 20_000 });
  const countdown = await live.innerText();
  await expect(live).not.toHaveText(countdown, { timeout: 5000 });
  await expect(page.getByRole("region", { name: "Power events" })).toContainText("on battery", {
    timeout: 20_000,
  });
  await screenshot("1728-dark-ups-on-battery.png");
  await page.waitForTimeout(31_000);
  await mode("OL");
  await expect(live).toContainText("Online", { timeout: 20_000 });
  await expect(page.getByRole("region", { name: "Power events" })).not.toContainText("ongoing", {
    timeout: 20_000,
  });
  for (const range of ["1h", "7d", "30d", "365d", "24h"]) {
    const request = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/v1/ups/history" &&
        new URL(response.url()).searchParams.get("range") === range,
    );
    await page.getByRole("button", { name: range, exact: true }).click();
    expect((await request).ok()).toBe(true);
    await expect(page.getByRole("button", { name: range, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  }
  await expect(page.locator(".ups-history-chart svg.recharts-surface")).toHaveCount(4);
  await expect(page.getByLabel("input history")).toContainText("OB");
  for (const theme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const contrast = await page.evaluate(() => {
      const luminance = (color: string) => {
        const rgb = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map((value) => {
            const channel = Number(value) / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
        return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
      };
      const text = document.querySelector(".ups-history-chart text")!;
      const foreground = luminance(getComputedStyle(text).fill);
      const background = luminance(getComputedStyle(text.closest(".ups-panel")!).backgroundColor);
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    reports.push({ theme, chartTextContrast: contrast });
    if (theme === "light") await screenshot("1728-light-ups-page.png");
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await screenshot("1728-dark-ups-page.png");
  reports.push({
    events: await page.getByRole("region", { name: "Power events" }).innerText(),
    energy: await page.getByRole("region", { name: "Energy", exact: true }).innerText(),
    health: await page.getByRole("region", { name: "Battery health" }).innerText(),
  });
  for (const range of ["24h", "7d", "30d", "365d"]) {
    const response = await page.request.get(`${origin}/v1/ups/energy?range=${range}`);
    const energy = (await response.json()) as components["schemas"]["UpsEnergy"];
    expect(energy.energy_mwh).toBeGreaterThan(0);
    expect(energy.electricity_rate_micro_usd_per_kwh).toBe(123456);
    reports.push({ range, energy });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await screenshot("390-dark-ups-page.png");
  await page.getByRole("link", { name: "Back to dashboard" }).click();
  await page.getByRole("link", { name: "UPS history and settings" }).click();
  await expect(page).toHaveURL(`${origin}/ups`);
  await page.goBack();
  await expect(page).toHaveURL(`${origin}/`);
  await page.getByRole("button", { name: "UPS: Online" }).click();
  await expect(page).toHaveURL(`${origin}/ups`);
  await page.goBack();
  await mode("ERR DATA-STALE");
  await expect(page.getByRole("region", { name: "UPS", exact: true })).toContainText("DATA-STALE", {
    timeout: 25_000,
  });
  await page.getByRole("button", { name: "UPS: No data" }).focus();
  await expect(page.locator('[data-slot="tooltip-content"]')).toContainText("DATA-STALE");
  await screenshot("390-dark-ups-warning.png");
  await mode("OL");
  await expect(page.getByRole("button", { name: "UPS: Online" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("region", { name: "UPS", exact: true })).not.toContainText(
    "DATA-STALE",
  );
  await page.setViewportSize({ width: 1728, height: 1117 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await expect(page.getByRole("region", { name: "UPS", exact: true })).toContainText("100%");
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    footerTop: document.querySelector("footer")!.getBoundingClientRect().top,
    gridBottom: document.querySelector(".dashboard-grid")!.getBoundingClientRect().bottom,
  }));
  expect(dimensions.width).toBe(1728);
  expect(dimensions.height).toBe(1117);
  expect(dimensions.gridBottom).toBeLessThanOrEqual(dimensions.footerTop);
  reports.push({ sandboxDashboard: dimensions });
  await screenshot("1728-light-dashboard-fit.png");
  // Stress the layout with the existing three-node/model/quota fixtures as well.
  const fixture = fixtures();
  await page.route("**/v1/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const data: Record<string, unknown> = {
      "/v1/fleet": fixture.fleet,
      "/v1/llm/usage": fixture.usage,
      "/v1/pricing": fixture.pricing,
      "/v1/agents": fixture.agents,
      "/v1/gpu": fixture.gpu,
    };
    if (pathname in data) await route.fulfill({ json: data[pathname] });
    else await route.continue();
  });
  await page.reload();
  await expect(page.getByText("factory-edge", { exact: true })).toBeVisible();
  await expect(page.getByRole("log")).toContainText("factory-", { timeout: 45_000 });
  const stress = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    footerTop: document.querySelector("footer")!.getBoundingClientRect().top,
    gridBottom: document.querySelector(".dashboard-grid")!.getBoundingClientRect().bottom,
  }));
  expect(stress.width).toBe(1728);
  expect(stress.height).toBe(1117);
  expect(stress.gridBottom).toBeLessThanOrEqual(stress.footerTop);
  reports.push({ fixtureStressDashboard: stress });
  await screenshot("1728-light-dashboard-stress.png");
  expect(errors).toEqual([]);
} finally {
  await mode("OL");
  await writeFile(
    new URL("ups-check.json", artifacts),
    JSON.stringify({ origin, reports, errors }, null, 2),
  );
  await browser.close();
}
console.log(JSON.stringify(reports, null, 2));
