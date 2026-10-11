import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= `${process.cwd()}/.browsers`;
const { chromium, expect } = await import("@playwright/test");
const browser = await chromium.launch();
await mkdir("screenshots", { recursive: true });
const reports: unknown[] = [];
const errors: string[] = [];
let streamMock: ReturnType<typeof spawn> | undefined;
const startStreamMock = () =>
  spawn(process.execPath, ["mock/server.ts"], {
    stdio: "ignore",
    env: { ...process.env, MOCK_PORT: "4184", MOCK_OUTAGE: "0" },
  });
try {
  for (const [width, height, theme] of [
    [1728, 1117, "dark"],
    [1728, 1117, "light"],
    [1024, 768, "dark"],
    [390, 844, "dark"],
    [390, 844, "light"],
  ] as const) {
    const page = await browser.newPage({
      viewport: { width, height },
      colorScheme: theme,
      reducedMotion: "reduce",
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://127.0.0.1:4180");
    await expect(page.getByText("$3.41 priced", { exact: true })).toBeVisible();
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
    await expect(page.getByRole("log")).toContainText("factory-console", { timeout: 10_000 });
    if (width === 1728 && theme === "dark")
      await expect(page.locator(".ticker li")).toHaveCount(6, { timeout: 35_000 });
    await expect(
      page.getByRole("region", { name: "GPU" }).locator(".recharts-area-area"),
    ).toBeVisible();
    const layout = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      viewport: innerHeight,
    }));
    await page.screenshot({ path: `screenshots/${width}-${theme}.png` });
    if (layout.width > width) throw new Error(`Horizontal overflow at ${width}: ${layout.width}`);
    if (width === 1728 && layout.height > height)
      throw new Error(`Kiosk does not fit: ${layout.height} > ${height}`);
    if (width === 390) {
      await expect(page.locator(".model-cards")).toBeVisible();
      await expect(page.locator(".model-table")).toBeHidden();
    }
    const contrast = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      function rgb(color: string) {
        context!.clearRect(0, 0, 1, 1);
        context!.fillStyle = color;
        context!.fillRect(0, 0, 1, 1);
        return Array.from(context!.getImageData(0, 0, 1, 1).data);
      }
      function luminance(color: string) {
        const [r = 0, g = 0, b = 0] = rgb(color).map((value) => {
          const c = value / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      }
      function ratio(a: string, b: string) {
        const l1 = luminance(a),
          l2 = luminance(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      }
      const style = getComputedStyle(document.documentElement);
      const token = (name: string) => style.getPropertyValue(`--${name}`).trim();
      const tokens = {
        primary: token("primary"),
        primaryForeground: token("primary-foreground"),
        accentText: token("accent-text"),
      };
      const pairs = {
        "white / primary": ratio(tokens.primaryForeground, tokens.primary),
        "accent / background": ratio(tokens.accentText, token("background")),
        "accent / card": ratio(tokens.accentText, token("card")),
        "muted / card": ratio(token("muted-foreground"), token("card")),
        "muted / muted": ratio(token("muted-foreground"), token("muted")),
        "ok / card": ratio(token("ok"), token("card")),
        "warn / card": ratio(token("warn"), token("card")),
        "fail / card": ratio(token("fail"), token("card")),
      };
      const failures: { text: string; ratio: number; foreground: string; background: string }[] =
        [];
      for (const element of document.querySelectorAll<HTMLElement>("body *")) {
        if (
          ["SCRIPT", "STYLE", "svg"].includes(element.tagName) ||
          !element.getClientRects().length
        )
          continue;
        const text = Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent?.trim() ?? "")
          .join(" ")
          .trim();
        if (!text) continue;
        const foreground = getComputedStyle(element).color;
        let parent: Element | null = element;
        let background = token("background");
        while (parent) {
          const color = getComputedStyle(parent).backgroundColor;
          if ((rgb(color)[3] ?? 0) === 255) {
            background = color;
            break;
          }
          parent = parent.parentElement;
        }
        const value = ratio(foreground, background);
        const css = getComputedStyle(element);
        const large =
          parseFloat(css.fontSize) >= 24 ||
          (parseFloat(css.fontSize) >= 18.66 && Number(css.fontWeight) >= 700);
        if (value < (large ? 3 : 4.5))
          failures.push({ text, ratio: value, foreground, background });
      }
      return { tokens, pairs, failures };
    });
    reports.push({ width, height, theme, layout, contrast });
    if (contrast.failures.length)
      throw new Error(`Contrast failures: ${JSON.stringify(contrast.failures)}`);
    if (width !== 1728)
      await page.screenshot({ path: `screenshots/${width}-${theme}-full.png`, fullPage: true });
    if (width === 1728) {
      await page
        .getByRole("region", { name: "Local LLM" })
        .getByRole("button", { name: "7d", exact: true })
        .click();
      await expect(page.getByText("$23.87 priced", { exact: true })).toBeVisible();
      await page
        .getByRole("region", { name: "GPU" })
        .getByRole("button", { name: "24h", exact: true })
        .click();
      await expect(
        page.getByRole("region", { name: "GPU" }).getByRole("button", { name: "24h", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(
        page.getByRole("region", { name: "GPU" }).locator(".recharts-area-area"),
      ).toBeVisible();
      await page
        .getByRole("button", { name: theme === "dark" ? "Use light theme" : "Use dark theme" })
        .focus();
      await page.keyboard.press("Shift+Tab");
      await expect(page.locator("[data-slot=tooltip-content]")).toContainText("1.0.0-mock");
      await page.screenshot({ path: `screenshots/1728-${theme}-details.png` });
    }
    await page.close();
  }
  const outage = await browser.newPage({
    viewport: { width: 1728, height: 1117 },
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  outage.on("pageerror", (error) => errors.push(error.message));
  await outage.route("**/v1/**", (route) => {
    const url = new URL(route.request().url());
    return route.continue({ url: `http://127.0.0.1:4182${url.pathname}${url.search}` });
  });
  await outage.goto("http://127.0.0.1:4180");
  await expect(outage.getByText("Meter unavailable. Usage cannot be retrieved.")).toBeVisible();
  await expect(outage.getByText("Telemetry unavailable")).toBeVisible();
  await expect(
    outage.getByText("Pricing provider unavailable. Reference rates are unknown."),
  ).toBeVisible();
  await outage.screenshot({ path: "screenshots/1728-dark-outage.png" });
  await outage.close();
  const states = await browser.newPage({
    viewport: { width: 1728, height: 1117 },
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  states.on("pageerror", (error) => errors.push(error.message));
  streamMock = startStreamMock();
  await states.route("**/v1/stream", (route) =>
    route.continue({ url: "http://127.0.0.1:4184/v1/stream" }),
  );
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await states.route("**/v1/fleet", async (route) => {
    await gate;
    await route.fulfill({ status: 503, body: "Unavailable" });
  });
  await states.goto("http://127.0.0.1:4180");
  await expect(
    states.getByRole("region", { name: "Fleet" }).getByLabel("Loading section"),
  ).toBeVisible();
  await expect(states.getByText("$3.41 priced", { exact: true })).toBeVisible();
  await states.screenshot({ path: "screenshots/1728-dark-loading.png" });
  release();
  await expect(states.getByText("Unable to load this section")).toBeVisible();
  await expect(states.getByText("Live", { exact: true })).toBeVisible();
  await states.screenshot({ path: "screenshots/1728-dark-error.png" });
  streamMock.kill();
  await expect(states.getByText("Reconnecting", { exact: true })).toBeVisible({ timeout: 10_000 });
  await states.screenshot({ path: "screenshots/1728-dark-reconnecting.png" });
  streamMock = startStreamMock();
  await expect(states.getByText("Live", { exact: true })).toBeVisible({ timeout: 10_000 });
  await states.close();
  if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`);
} finally {
  streamMock?.kill();
  await browser.close();
  await writeFile("screenshots/checks.json", JSON.stringify({ reports, errors }, null, 2) + "\n");
}
console.log("Screenshots, SSE, ranges, layout, tooltips and rendered text contrast passed.");
