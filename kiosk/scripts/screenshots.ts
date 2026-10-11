import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fixtures } from "../mock/fixtures.ts";

declare global {
  interface Window {
    themeProbe: { timeOrigin: number; fcp: number; background: string; samples: string[] };
  }
}

process.env.PLAYWRIGHT_BROWSERS_PATH ??= `${process.cwd()}/.browsers`;
const { chromium, expect } = await import("@playwright/test");
const browser = await chromium.launch();
await mkdir("screenshots", { recursive: true });
const reports: unknown[] = [];
const errors: string[] = [];
const firstFrameDirectory = process.env.FIRST_FRAME_DIRECTORY ?? "screenshots/first-frame";
await mkdir(firstFrameDirectory, { recursive: true });
async function firstFrames(url: string, placeholder = false) {
  const results = [];
  const decoder = await browser.newPage();
  try {
    for (const [system, saved] of (placeholder
      ? [
          ["dark", null],
          ["light", null],
        ]
      : [
          ["dark", null],
          ["light", null],
          ["light", "dark"],
          ["dark", "light"],
          ["dark", "invalid"],
          ["light", "invalid"],
          ["dark", "blocked"],
          ["light", "blocked"],
        ]) as ["dark" | "light", "dark" | "light" | "invalid" | "blocked" | null][]) {
      const explicit = saved === "dark" || saved === "light" ? saved : null;
      const expected = (explicit ?? system) === "dark" ? "rgb(19, 19, 21)" : "rgb(246, 246, 247)";
      const name = `${placeholder ? "placeholder" : "kiosk"}-${system}${saved ? `-saved-${saved}` : ""}`;
      const page = await browser.newPage({
        colorScheme: system,
        viewport: { width: 1728, height: 1117 },
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript((preference) => {
        if (preference === "blocked")
          Object.defineProperty(window, "localStorage", {
            get() {
              throw new DOMException("Storage blocked", "SecurityError");
            },
          });
        else if (!sessionStorage.getItem("theme-check-seeded")) {
          if (preference) localStorage.setItem("factory-theme", preference);
          else localStorage.removeItem("factory-theme");
          sessionStorage.setItem("theme-check-seeded", "true");
        }
        window.themeProbe = {
          timeOrigin: performance.timeOrigin,
          fcp: 0,
          background: "",
          samples: [],
        };
        const sample = () => {
          if (document.body)
            window.themeProbe.samples.push(getComputedStyle(document.body).backgroundColor);
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        new PerformanceObserver((list) => {
          const paint = list.getEntries().find((entry) => entry.name === "first-contentful-paint");
          if (paint) {
            window.themeProbe.fcp = paint.startTime;
            window.themeProbe.background = getComputedStyle(document.body).backgroundColor;
          }
        }).observe({ type: "paint", buffered: true });
      }, saved);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
      await page.goto(url);
      const frames: { data: string; timestamp: number }[] = [];
      cdp.on("Page.screencastFrame", (frame) => {
        frames.push({ data: frame.data, timestamp: frame.metadata.timestamp ?? 0 });
        void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
      });
      await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
      if (process.env.FIRST_FRAME_RELOAD === "self-update" && !placeholder) {
        await page.route("**/version.json", (route) =>
          route.fulfill({ json: { build: "f".repeat(64) } }),
        );
        await Promise.all([
          page.waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame() }),
          page.evaluate(() => window.dispatchEvent(new Event("online"))),
        ]);
        await page.unroute("**/version.json");
        await page.waitForLoadState();
      } else {
        await page.reload();
      }
      await page.waitForFunction(() => window.themeProbe.fcp > 0);
      await page.waitForTimeout(500);
      await cdp.send("Page.stopScreencast");
      const probe = await page.evaluate(() => window.themeProbe);
      const painted = frames.filter((frame) => frame.timestamp * 1000 >= probe.timeOrigin);
      expect(painted.length, `${name}: captured frames`).toBeGreaterThan(0);
      await writeFile(
        `${firstFrameDirectory}/${name}.png`,
        Buffer.from(painted[0]!.data, "base64"),
      );
      const pixels = [];
      for (const frame of painted) {
        pixels.push(
          await decoder.evaluate(async (data) => {
            const image = new Image();
            image.src = `data:image/png;base64,${data}`;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 1;
            const context = canvas.getContext("2d")!;
            context.drawImage(image, 0, 0);
            const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
            return `rgb(${r}, ${g}, ${b})`;
          }, frame.data),
        );
      }
      const result = {
        name,
        url,
        system,
        saved,
        expected,
        reload: process.env.FIRST_FRAME_RELOAD ?? "manual",
        cacheDisabled: true,
        cpuThrottle: 6,
        fcpMs: probe.fcp,
        firstFrameBackground: probe.background,
        animationFrameBackgrounds: [...new Set(probe.samples)],
        screencastBackgrounds: [...new Set(pixels)],
        frames: painted.length,
      };
      results.push(result);
      await writeFile(
        `${firstFrameDirectory}/${name}.json`,
        JSON.stringify(result, null, 2) + "\n",
      );
      console.log(JSON.stringify(result));
      expect(probe.background, `${name}: first contentful paint`).toBe(expected);
      expect([...new Set(probe.samples)], `${name}: every animation frame`).toEqual([expected]);
      expect([...new Set(pixels)], `${name}: every captured frame`).toEqual([expected]);
      if (!placeholder) {
        const opposite = system === "dark" ? "light" : "dark";
        await page.emulateMedia({ colorScheme: opposite });
        await expect(page.locator("html")).toHaveAttribute("data-theme", explicit ?? opposite);
        await page.emulateMedia({ colorScheme: system });
        await expect(page.locator("html")).toHaveAttribute("data-theme", explicit ?? system);
        if ((await page.locator("html").getAttribute("data-theme")) === system)
          await page.getByRole("button", { name: /Use (light|dark) theme/ }).click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", opposite);
        if (saved !== "blocked") {
          expect(await page.evaluate(() => localStorage.getItem("factory-theme"))).toBe(opposite);
          await page.reload();
          await expect(page.locator("html")).toHaveAttribute("data-theme", opposite);
          expect(await page.evaluate(() => localStorage.getItem("factory-theme"))).toBe(opposite);
        }
        await page.getByRole("button", { name: /Use (light|dark) theme/ }).click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", system);
        await expect(page.locator("html")).not.toHaveAttribute("data-theme-preference");
        if (saved !== "blocked")
          expect(await page.evaluate(() => localStorage.getItem("factory-theme"))).toBeNull();
        await page.emulateMedia({ colorScheme: opposite });
        await expect(page.locator("html")).toHaveAttribute("data-theme", opposite);
      }
      await page.close();
    }
  } finally {
    await decoder.close();
  }
  return results;
}

let streamMock: ReturnType<typeof spawn> | undefined;
const startStreamMock = () =>
  spawn(process.execPath, ["mock/server.ts"], {
    stdio: "ignore",
    env: { ...process.env, MOCK_PORT: "4184", MOCK_OUTAGE: "0" },
  });
try {
  reports.push(
    ...(await firstFrames(process.env.FIRST_FRAME_URL ?? "http://127.0.0.1:4180/?kiosk")),
  );
  if (process.env.PLACEHOLDER_URL)
    reports.push(...(await firstFrames(process.env.PLACEHOLDER_URL, true)));
  if (!process.env.FIRST_FRAME_ONLY) {
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
        const probe = document.createElement("span");
        probe.hidden = true;
        document.body.append(probe);
        const token = (name: string) => {
          probe.style.color = `var(--${name})`;
          const [r, g, b] = rgb(getComputedStyle(probe).color);
          return `rgb(${r}, ${g}, ${b})`;
        };
        const tokens = {
          primary: token("primary"),
          primaryForeground: token("primary-foreground"),
          accentText: token("accent-text"),
          background: token("background"),
          card: token("card"),
          mutedForeground: token("muted-foreground"),
          muted: token("muted"),
          ok: token("ok"),
          warn: token("warn"),
          fail: token("fail"),
        };
        probe.remove();
        const pairs = {
          "white / primary": ratio(tokens.primaryForeground, tokens.primary),
          "accent / background": ratio(tokens.accentText, tokens.background),
          "accent / card": ratio(tokens.accentText, tokens.card),
          "muted / card": ratio(tokens.mutedForeground, tokens.card),
          "muted / muted": ratio(tokens.mutedForeground, tokens.muted),
          "ok / card": ratio(tokens.ok, tokens.card),
          "warn / card": ratio(tokens.warn, tokens.card),
          "fail / card": ratio(tokens.fail, tokens.card),
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
          let background = tokens.background;
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
          page
            .getByRole("region", { name: "GPU" })
            .getByRole("button", { name: "24h", exact: true }),
        ).toHaveAttribute("aria-pressed", "true");
        await expect(
          page.getByRole("region", { name: "GPU" }).locator(".recharts-area-area"),
        ).toBeVisible();
        await page
          .getByRole("button", { name: theme === "dark" ? "Use light theme" : "Use dark theme" })
          .focus();
        await page.keyboard.press("Shift+Tab");
        await expect(page.locator("[data-slot=tooltip-content]")).toContainText(
          `API ${fixtures().health.version}`,
        );
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
    let releaseChart = () => {};
    const chartGate = new Promise<void>((resolve) => {
      releaseChart = resolve;
    });
    await states.route("**/assets/gpu-chart-*.js", async (route) => {
      await chartGate;
      await route.continue();
    });
    await states.goto("http://127.0.0.1:4180");
    await expect(
      states.getByRole("region", { name: "Fleet" }).getByLabel("Loading section"),
    ).toBeVisible();
    await expect(states.getByText("$3.41 priced", { exact: true })).toBeVisible();
    await expect(states.getByLabel("Loading GPU chart")).toBeVisible();
    await states.screenshot({ path: "screenshots/1728-dark-chart-loading.png" });
    releaseChart();
    await expect(
      states.getByRole("region", { name: "GPU" }).locator(".recharts-area-area"),
    ).toBeVisible();
    await states.screenshot({ path: "screenshots/1728-dark-loading.png" });
    release();
    await expect(states.getByText("Unable to load this section")).toBeVisible();
    await expect(states.getByText("Live", { exact: true })).toBeVisible();
    await states.screenshot({ path: "screenshots/1728-dark-error.png" });
    streamMock.kill();
    await expect(states.getByText("Reconnecting", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await states.screenshot({ path: "screenshots/1728-dark-reconnecting.png" });
    streamMock = startStreamMock();
    await expect(states.getByText("Live", { exact: true })).toBeVisible({ timeout: 10_000 });
    await states.close();
  }
  if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`);
} finally {
  streamMock?.kill();
  await browser.close();
  await writeFile("screenshots/checks.json", JSON.stringify({ reports, errors }, null, 2) + "\n");
}
console.log(
  process.env.FIRST_FRAME_ONLY
    ? "First-frame and theme interaction checks passed."
    : "First frames, screenshots, SSE, ranges, layout, tooltips and rendered text contrast passed.",
);
