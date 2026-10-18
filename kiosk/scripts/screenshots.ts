import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fixtures } from "../mock/fixtures.ts";
import type { Page } from "@playwright/test";

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
const KIOSK = { width: 1728, height: 1117 } as const;
// --background from index.html, per theme, as Chromium reports it.
const BODY = { dark: "rgb(13, 18, 24)", light: "rgb(242, 246, 247)" } as const;

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
      const expected = BODY[explicit ?? system];
      const name = `${placeholder ? "placeholder" : "kiosk"}-${system}${saved ? `-saved-${saved}` : ""}`;
      const page = await browser.newPage({ colorScheme: system, viewport: KIOSK });
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
      // The top-left pixel is the topbar glass over the sky once React mounts: the same theme
      // within a few units of the body colour, never the other theme.
      const channels = (color: string) => color.match(/\d+/g)!.map(Number);
      for (const pixel of new Set(pixels))
        expect(
          Math.max(...channels(pixel).map((value, i) => Math.abs(value - channels(expected)[i]!))),
          `${name}: captured frame ${pixel} is off the ${expected} theme`,
        ).toBeLessThanOrEqual(8);
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

/** The kiosk never scrolls: neither the document nor the dashboard pane. */
async function assertNoScroll(page: Page, name: string) {
  const layout = await page.evaluate(() => {
    const dashboard = document.querySelector(".dashboard");
    return {
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      viewport: innerHeight,
      dashboardOverflow: dashboard ? dashboard.scrollHeight - dashboard.clientHeight : 0,
    };
  });
  const { width, height } = page.viewportSize()!;
  if (layout.width > width)
    throw new Error(`${name}: horizontal overflow ${layout.width} > ${width}`);
  if (layout.height > height) throw new Error(`${name}: page scrolls ${layout.height} > ${height}`);
  if (layout.dashboardOverflow > 0)
    throw new Error(`${name}: dashboard scrolls by ${layout.dashboardOverflow}px`);
  return layout;
}

/** Under prefers-reduced-motion nothing animates: no CSS animation or transition is running. */
async function assertStill(page: Page, name: string) {
  const running = await page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => animation.playState === "running")
      .map((animation) =>
        animation instanceof CSSAnimation
          ? animation.animationName
          : animation instanceof CSSTransition
            ? `transition:${animation.transitionProperty}`
            : animation.constructor.name,
      ),
  );
  if (running.length)
    throw new Error(`${name}: animations under reduced motion: ${running.join(", ")}`);
}

/**
 * Rendered contrast, measured in the browser. Glass panels are translucent, so every text
 * element's background is its ancestor stack composited over the worst case of what the scene
 * can show behind its rect: the sky gradient at those heights, the far ridge, and below the
 * ridgeline the ridges, the snow at the highest peak and the alpenglow sweep, plus the aurora
 * where its ellipses sit; each raw and at the glass's 170% saturation. Text must reach 4.5:1
 * against every one of them; a control's boundary (border or fill, else its glyph) 3:1.
 */
async function auditContrast(page: Page, name: string) {
  const result = await page.evaluate(() => {
    type RGBA = [number, number, number, number];
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const parse = (color: string): RGBA => {
      const rgb = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(color);
      if (rgb) return [+rgb[1]!, +rgb[2]!, +rgb[3]!, rgb[4] === undefined ? 1 : +rgb[4]];
      const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(color);
      if (srgb)
        return [
          +srgb[1]! * 255,
          +srgb[2]! * 255,
          +srgb[3]! * 255,
          srgb[4] === undefined ? 1 : +srgb[4],
        ];
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top: RGBA, under: RGBA): RGBA => {
      const a = top[3] + under[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      const mix = (i: 0 | 1 | 2) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
      return [mix(0), mix(1), mix(2), a];
    };
    const luminance = ([r, g, b]: RGBA) => {
      const [lr = 0, lg = 0, lb = 0] = [r, g, b].map((value) => {
        const c = value / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    };
    const ratio = (a: RGBA, b: RGBA) => {
      const l1 = luminance(a),
        l2 = luminance(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    // backdrop-filter: saturate(s), the SVG saturate matrix applied to the scene colour.
    const saturate = ([r, g, b, a]: RGBA, s: number): RGBA => [
      (0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b,
      (0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b,
      (0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b,
      a,
    ];
    const probe = document.createElement("span");
    probe.hidden = true;
    document.body.append(probe);
    const token = (tokenName: string) => {
      probe.style.color = `var(--${tokenName})`;
      return parse(getComputedStyle(probe).color);
    };
    const ridgeFar = token("ridge-far");
    const ridgeMid = token("ridge-mid");
    const ridgeNear = token("ridge-near");
    const snow = token("snow");
    const accent = token("accent-text");
    const ok = token("ok");
    const background = token("background");
    probe.remove();
    const rootStyle = getComputedStyle(document.documentElement);
    const sweepOpacity = parseFloat(rootStyle.getPropertyValue("--sweep-opacity"));
    const snowOpacity = parseFloat(rootStyle.getPropertyValue("--snow-opacity"));
    // The scene's geometry, read from the rendered backdrop: the sky gradient stops, the band
    // and where its ridgelines start, the snow fade and the aurora ellipses.
    const backdrop = document.querySelector<HTMLElement>(".fk-backdrop");
    const skyStops = backdrop
      ? [
          ...getComputedStyle(backdrop).backgroundImage.matchAll(
            /(rgba?\([^)]*\)|color\(srgb [^)]*\)) ([\d.]+)%/g,
          ),
        ].map((match) => ({ color: parse(match[1]!), at: +match[2]! / 100 }))
      : [];
    const skyAt = (y: number): RGBA => {
      const t = Math.min(1, Math.max(0, y / innerHeight));
      const next = skyStops.findIndex((stop) => stop.at >= t);
      if (next <= 0) return (skyStops[Math.max(next, 0)] ?? { color: background }).color;
      const from = skyStops[next - 1]!,
        to = skyStops[next]!;
      const k = (t - from.at) / (to.at - from.at || 1);
      return from.color.map((value, i) => value + (to.color[i]! - value) * k) as RGBA;
    };
    const bandTop = document.querySelector(".fk-band")?.getBoundingClientRect().top ?? Infinity;
    const rimBox = document.querySelector<SVGPathElement>(".fk-rim")?.getBBox();
    const nearTop = bandTop + (rimBox?.y ?? 0);
    const nearBottom = bandTop + (rimBox ? rimBox.y + rimBox.height : 0);
    const farTop =
      bandTop + (document.querySelector<SVGPathElement>(".fk-ridge-far")?.getBBox().y ?? 0);
    const snowFade = +(document.querySelector("#fk-snow")?.getAttribute("y2") ?? 1);
    const snowAlpha = Math.max(0, snowOpacity * (1 - (rimBox?.y ?? 0) / snowFade));
    const auroras = [...document.querySelectorAll(".fk-aurora")]
      .map((aurora) => aurora.getBoundingClientRect())
      .filter((rect) => rect.height > 0);
    /** What the scene can show behind a viewport rect; each colour raw and glass-saturated. */
    const sceneBehind = (rect: DOMRect): RGBA[] => {
      if (!backdrop) return [background];
      const top = Math.max(0, Math.min(rect.top, innerHeight - 1));
      const bottom = Math.max(top + 1, Math.min(rect.bottom, innerHeight));
      const samples: RGBA[] = [];
      if (top < nearBottom) {
        const ys = [
          top,
          Math.min(bottom, nearBottom),
          ...skyStops.map((stop) => stop.at * innerHeight).filter((y) => y > top && y < bottom),
        ];
        for (const y of ys) {
          samples.push(skyAt(y));
          if (auroras.some((aurora) => y >= aurora.top && y <= aurora.bottom))
            samples.push(over([ok[0], ok[1], ok[2], 0.32], skyAt(y)));
        }
        if (bottom > farTop) {
          const far: RGBA = [ridgeFar[0], ridgeFar[1], ridgeFar[2], 0.75];
          samples.push(over(far, skyAt(Math.max(top, farTop))), over(far, skyAt(bottom)));
        }
      }
      if (bottom > nearTop) {
        const sweep: RGBA = [accent[0], accent[1], accent[2], sweepOpacity];
        samples.push(
          ridgeMid,
          ridgeNear,
          over([snow[0], snow[1], snow[2], snowAlpha], ridgeMid),
          over(sweep, ridgeMid),
          over(sweep, ridgeNear),
        );
      }
      return [...samples, ...samples.map((color) => saturate(color, 1.7))];
    };
    const root = document.getElementById("root");
    /** Background colours from `element` up to #root, inner first, plus the inherited opacity. */
    const stack = (element: Element | null, rect: DOMRect) => {
      const layers: RGBA[] = [];
      let opacity = 1;
      let opaque = false;
      for (let node = element; node && node !== root; node = node.parentElement) {
        const css = getComputedStyle(node);
        opacity *= parseFloat(css.opacity);
        if (opaque) continue;
        const color = parse(css.backgroundColor);
        if (color[3] > 0) layers.push(color);
        if (color[3] >= 1) opaque = true;
      }
      const bases = opaque ? [layers.pop()!] : sceneBehind(rect);
      const compose = (base: RGBA) =>
        layers.reduceRight((under, layer) => over(layer, under), base);
      return { backgrounds: bases.map(compose), opacity };
    };
    const worst = (foreground: RGBA, backgrounds: RGBA[]) =>
      backgrounds.reduce((min, background) => {
        const fg = over(foreground, background);
        return Math.min(min, ratio(fg, background));
      }, Infinity);
    const rgba = ([r, g, b, a]: RGBA) =>
      `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a.toFixed(2)})`;
    const visible = (element: Element) => {
      if (element.closest("svg, script, style, [hidden]")) return false;
      const css = getComputedStyle(element);
      if (css.visibility === "hidden" || css.display === "none") return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    };
    const text: { text: string; ratio: number; foreground: string; background: string }[] = [];
    for (const element of document.querySelectorAll<HTMLElement>("body *")) {
      if (!visible(element)) continue;
      const content = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent?.trim() ?? "")
        .join(" ")
        .trim();
      if (!content) continue;
      const { backgrounds, opacity } = stack(element, element.getBoundingClientRect());
      const color = parse(getComputedStyle(element).color);
      const foreground: RGBA = [color[0], color[1], color[2], color[3] * opacity];
      const value = worst(foreground, backgrounds);
      const against = backgrounds.reduce((a, b) =>
        ratio(over(foreground, a), a) < ratio(over(foreground, b), b) ? a : b,
      );
      text.push({
        text: content.slice(0, 40),
        ratio: value,
        foreground: rgba(foreground),
        background: rgba(against),
      });
    }
    const controls: { control: string; ratio: number; cue: string }[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"]',
    )) {
      if (!visible(element)) continue;
      if (element.matches(":disabled, [aria-disabled='true']")) continue;
      const css = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const outer = stack(element.parentElement, rect).backgrounds;
      const cues: [string, number][] = [];
      const borderColor = parse(css.borderTopColor);
      if (parseFloat(css.borderTopWidth) > 0 && css.borderTopStyle !== "none" && borderColor[3] > 0)
        cues.push(["border", worst(borderColor, outer)]);
      const fill = parse(css.backgroundColor);
      if (fill[3] > 0) cues.push(["fill", worst(fill, outer)]);
      if (!cues.length) {
        const { backgrounds, opacity } = stack(element, rect);
        const color = parse(css.color);
        cues.push([
          "glyph",
          worst([color[0], color[1], color[2], color[3] * opacity], backgrounds),
        ]);
      }
      const [cue, value] = cues.reduce((best, next) => (next[1] > best[1] ? next : best));
      controls.push({
        control:
          (element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "").slice(0, 40) ||
          element.className.toString().slice(0, 40),
        ratio: value,
        cue,
      });
    }
    return { text, controls };
  });
  const textMin = result.text.reduce((min, entry) => (entry.ratio < min.ratio ? entry : min));
  const controlMin = result.controls.reduce((min, entry) =>
    entry.ratio < min.ratio ? entry : min,
  );
  const failures = {
    text: result.text.filter((entry) => entry.ratio < 4.5),
    controls: result.controls.filter((entry) => entry.ratio < 3),
  };
  if (failures.text.length || failures.controls.length)
    throw new Error(`${name}: contrast failures ${JSON.stringify(failures)}`);
  console.log(
    `${name}: text ≥ ${textMin.ratio.toFixed(2)}:1 ("${textMin.text}"), controls ≥ ${controlMin.ratio.toFixed(2)}:1 ("${controlMin.control}" ${controlMin.cue})`,
  );
  return { textMin, controlMin, failures };
}

/** Every 1728×1117 state: fits without scrolling, stays still and passes contrast. */
async function checkState(page: Page, name: string, path: string) {
  await page.screenshot({ path });
  const layout = await assertNoScroll(page, name);
  await assertStill(page, name);
  const contrast = await auditContrast(page, name);
  reports.push({ name, path, layout, contrast });
}

const gpuChart = (page: Page) => page.getByRole("region", { name: "GPU" }).locator(".comet");
let streamMock: ReturnType<typeof spawn> | undefined;
const startStreamMock = () =>
  spawn(process.execPath, ["mock/server.ts"], {
    stdio: "ignore",
    env: { ...process.env, MOCK_PORT: "4184", MOCK_OUTAGE: "0" },
  });
/** Stops the stream mock and waits for it to exit, so the next one can take port 4184. */
const stopStreamMock = async () => {
  const mock = streamMock;
  streamMock = undefined;
  if (!mock || mock.exitCode !== null) return;
  const exited = new Promise((resolve) => mock.once("exit", resolve));
  mock.kill();
  await exited;
};
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
      await expect(page.locator(".stat-value", { hasText: "$3.41" })).toBeVisible();
      await expect(page.getByText("Live", { exact: true })).toBeVisible();
      await expect(page.getByRole("log")).toContainText("factory-console", { timeout: 10_000 });
      if (width === 1728 && theme === "dark")
        await expect(page.locator(".ticker li")).toHaveCount(6, { timeout: 35_000 });
      await expect(gpuChart(page)).toBeVisible();
      const name = `${width}-${theme}`;
      if (width === 1728) await checkState(page, name, `screenshots/${name}.png`);
      else {
        await page.screenshot({ path: `screenshots/${name}.png` });
        const layout = await page.evaluate(() => document.documentElement.scrollWidth);
        if (layout > width) throw new Error(`${name}: horizontal overflow ${layout} > ${width}`);
        await assertStill(page, name);
        reports.push({ name, contrast: await auditContrast(page, name) });
        await page.screenshot({ path: `screenshots/${name}-full.png`, fullPage: true });
      }
      if (width === 1728) {
        await page
          .getByRole("region", { name: "GPU" })
          .getByRole("button", { name: "24h", exact: true })
          .click();
        await expect(
          page
            .getByRole("region", { name: "GPU" })
            .getByRole("button", { name: "24h", exact: true }),
        ).toHaveAttribute("aria-pressed", "true");
        await expect(gpuChart(page)).toBeVisible();
        await page
          .getByRole("button", { name: theme === "dark" ? "Use light theme" : "Use dark theme" })
          .focus();
        await page.keyboard.press("Shift+Tab");
        await expect(page.locator("[data-slot=tooltip-content]")).toContainText(
          `API ${fixtures().health.version}`,
        );
        await checkState(page, `${name}-details`, `screenshots/${name}-details.png`);
      }
      await page.close();
    }
    for (const theme of ["dark", "light"] as const) {
      const outage = await browser.newPage({
        viewport: KIOSK,
        colorScheme: theme,
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
      await checkState(outage, `1728-${theme}-outage`, `screenshots/1728-${theme}-outage.png`);
      await outage.close();

      const states = await browser.newPage({
        viewport: KIOSK,
        colorScheme: theme,
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
      await expect(states.locator(".stat-value", { hasText: "$3.41" })).toBeVisible();
      await expect(states.getByLabel("Loading GPU chart")).toBeVisible();
      await checkState(
        states,
        `1728-${theme}-chart-loading`,
        `screenshots/1728-${theme}-chart-loading.png`,
      );
      releaseChart();
      await expect(gpuChart(states)).toBeVisible();
      await checkState(states, `1728-${theme}-loading`, `screenshots/1728-${theme}-loading.png`);
      release();
      await expect(states.getByText("Unable to load this section")).toBeVisible();
      await expect(states.getByText("Live", { exact: true })).toBeVisible();
      await checkState(states, `1728-${theme}-error`, `screenshots/1728-${theme}-error.png`);
      await stopStreamMock();
      await expect(states.getByText("Reconnecting", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await checkState(
        states,
        `1728-${theme}-reconnecting`,
        `screenshots/1728-${theme}-reconnecting.png`,
      );
      streamMock = startStreamMock();
      await expect(states.getByText("Live", { exact: true })).toBeVisible({ timeout: 10_000 });
      await states.close();
      await stopStreamMock();
    }
  }
  if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`);
} finally {
  await stopStreamMock();
  await browser.close();
  await writeFile("screenshots/checks.json", JSON.stringify({ reports, errors }, null, 2) + "\n");
}
console.log(
  process.env.FIRST_FRAME_ONLY
    ? "First-frame and theme interaction checks passed."
    : "First frames, screenshots, SSE, ranges, no-scroll, reduced-motion, tooltips and rendered contrast passed.",
);
