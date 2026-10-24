import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// MET-227: the ambient scene at the kiosk size, per mode and theme. The default URL is the
// `both` scene (MET-237's decision); `?ambient=sweep|none|static` are diagnostic overrides and
// `?perf=1` starts the frame sampler. Origin: AMBIENT_ORIGIN, else this worktree's sandbox,
// else the mock preview (`vp run mock-preview`). Every origin except the sandbox (whose
// synthetic data is healthy) must show plain, warning and failure panels, as the mock does.
const root = new URL("../../", import.meta.url);
const ports = new URL(".sandbox/ports.json", root);
const sandbox = existsSync(ports)
  ? `http://127.0.0.1:${(JSON.parse(await readFile(ports, "utf8")) as { "factory-api": number })["factory-api"]}`
  : undefined;
const origin = process.env.AMBIENT_ORIGIN ?? sandbox ?? "http://127.0.0.1:4180";
const requireTones = origin !== sandbox;
const artifacts = new URL(".amp/in/artifacts/ambient/", root);
await mkdir(artifacts, { recursive: true });
process.env.PLAYWRIGHT_BROWSERS_PATH ??= `${process.cwd()}/.browsers`;
const { chromium } = await import("@playwright/test");
const browser = await chromium.launch();

const modes = ["both", "sweep", "none", "static"] as const;
type Mode = (typeof modes)[number];
const themes = ["dark", "light"] as const;
type Theme = (typeof themes)[number];
const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

/** Running scene animations per mode: the sweep in every mode but `none`, plus two aurora
 * ellipses and 50 stars for `both` at night. `static` keeps the sweep (it only drops the blur). */
const sceneKeyframes = new Set(["sweep", "aurora", "twinkle"]);
const sceneAnimations = (mode: Mode, theme: Theme) =>
  mode === "none" ? 0 : mode === "both" && theme === "dark" ? 53 : 1;

/** Scene animations are paused while the page is quiet (IDLE_HOLD_MS in lib/motion.ts). */
const scenePlayState =
  "document.querySelector('.fk-backdrop')?.classList.contains('fk-still') ? 'paused' : 'running'";

/** Loads a URL, lets the panels finish their entrance, and reads what the checks need. */
async function visit(query: string, theme: Theme, reducedMotion = false) {
  const page = await browser.newPage({
    viewport: { width: 1728, height: 1117 },
    colorScheme: theme,
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/${query}`);
  await page.getByRole("region", { name: "Fleet" }).waitFor();
  // The default scene pauses 2 s after load. Wake it, read the running scene, then let it hold.
  if (!reducedMotion) {
    await page.mouse.click(8, 8);
    await page.waitForFunction(`${scenePlayState} === "running"`);
  }
  await page.waitForTimeout(400);
  const state = await page.evaluate(() => {
    const dashboard = document.querySelector(".dashboard");
    return {
      ambientAttribute: document.documentElement.dataset.ambient ?? null,
      sceneElements: document.querySelectorAll(".fk-backdrop, [data-ambient-scene]").length,
      staticSky: document.documentElement.style.getPropertyValue("--fk-static-sky") !== "",
      verdict: document.querySelector(".verdict")?.textContent?.trim() ?? null,
      panels: [...document.querySelectorAll<HTMLElement>(".panel")].map((panel, i) => {
        const style = getComputedStyle(panel);
        return {
          name: panel.getAttribute("aria-label") ?? `panel ${i}`,
          tone: panel.dataset.tone ?? "plain",
          backdrop: style.backdropFilter,
          shadow: style.boxShadow,
        };
      }),
      pageScroll: {
        scrollHeight: document.documentElement.scrollHeight,
        scrollWidth: document.documentElement.scrollWidth,
        innerHeight,
        innerWidth,
      },
      dashboardOverflow: dashboard ? dashboard.scrollHeight - dashboard.clientHeight : null,
      pulseRing: (() => {
        const live = document.querySelector(".live-indicator .chip-dot");
        const plain = document.querySelector(".chip-dot:not(.chip-dot-pulse)");
        const ring = live ? getComputedStyle(live, "::after") : null;
        return {
          liveHasRing: ring !== null && ring.content !== "none" && ring.borderTopWidth !== "0px",
          liveAnimates: ring !== null && ring.animationName !== "none",
          plainHasRing: plain !== null && getComputedStyle(plain, "::after").content !== "none",
        };
      })(),
      scene: document.querySelector(".fk-backdrop")?.classList.contains("fk-still")
        ? "paused"
        : "running",
      // Held scenes stay in the animation list with playState "paused"; count those too,
      // so a quiet page still reports the sweep, aurora and stars it will resume.
      running: document
        .getAnimations()
        .filter(
          (animation) => animation.playState === "running" || animation.playState === "paused",
        )
        .map((animation) =>
          animation instanceof CSSAnimation ? animation.animationName : animation.constructor.name,
        ),
      perf: (window as { __ambientPerf?: { mode: string } }).__ambientPerf ?? null,
    };
  });
  return { page, state, errors };
}

const report: Record<string, unknown> = { origin };
try {
  for (const theme of themes) {
    // The default URL is the `both` scene with the perf sampler off.
    const base = await visit("", theme);
    await base.page.screenshot({
      path: fileURLToPath(new URL(`1728-${theme}-default.png`, artifacts)),
    });
    await base.page.close();
    check(base.state.ambientAttribute === "both", `${theme} default: data-ambient is not both`);
    check(base.state.sceneElements > 0, `${theme} default: no scene`);
    check(base.state.verdict !== null, `${theme} default: no verdict strip`);
    check(base.state.perf === null, `${theme} default: perf sampler running without ?perf=1`);
    check(base.errors.length === 0, `${theme} default: page errors ${base.errors.join("; ")}`);
    check(
      base.state.pulseRing.liveHasRing && !base.state.pulseRing.liveAnimates,
      `${theme} default: Live pulse is not a steady ring`,
    );
    check(!base.state.pulseRing.plainHasRing, `${theme} default: a plain dot also has a ring`);
    const tones = new Set(base.state.panels.map((panel) => panel.tone));
    if (requireTones)
      for (const tone of ["plain", "warn", "fail"])
        check(tones.has(tone), `${theme} default: no ${tone} panel to check (populated mock?)`);
    // Unknown modes fall back to the default.
    const unknown = await visit("?ambient=stars", theme);
    await unknown.page.close();
    check(
      unknown.state.ambientAttribute === "both" && unknown.state.perf === null,
      `${theme} ?ambient=stars: did not fall back to both`,
    );
    report[`${theme}-default`] = base.state;

    for (const mode of modes) {
      const label = `${theme} ${mode}`;
      const moving = await visit(`?ambient=${mode}&perf=1`, theme);
      await moving.page.screenshot({
        path: fileURLToPath(new URL(`1728-${theme}-${mode}.png`, artifacts)),
      });
      let held: string | undefined;
      if (mode !== "none") {
        await moving.page.mouse.click(8, 8);
        await moving.page.waitForTimeout(2_400);
        held = await moving.page.evaluate(scenePlayState);
      }
      await moving.page.close();
      const still = await visit(`?ambient=${mode}`, theme, true);
      await still.page.screenshot({
        path: fileURLToPath(new URL(`1728-${theme}-${mode}-reduced.png`, artifacts)),
      });
      await still.page.close();
      const scene = moving.state.running.filter((name) => sceneKeyframes.has(name));
      const expected = sceneAnimations(mode, theme);
      const { scrollHeight, scrollWidth, innerHeight, innerWidth } = moving.state.pageScroll;
      check(moving.state.ambientAttribute === mode, `${label}: data-ambient is not ${mode}`);
      check(moving.state.sceneElements > 0, `${label}: no scene`);
      check(
        moving.state.staticSky === (mode === "static"),
        `${label}: --fk-static-sky ${moving.state.staticSky ? "set" : "missing"}`,
      );
      check(
        scene.length === expected,
        `${label}: ${scene.length} scene animations, expected ${expected}`,
      );
      check(
        scrollHeight <= innerHeight && scrollWidth <= innerWidth,
        `${label}: page scrolls (${scrollWidth}×${scrollHeight})`,
      );
      check(
        moving.state.dashboardOverflow !== null && moving.state.dashboardOverflow <= 0,
        `${label}: dashboard overflows by ${moving.state.dashboardOverflow}px`,
      );
      check(
        moving.state.panels.length === base.state.panels.length,
        `${label}: ${moving.state.panels.length} panels, default has ${base.state.panels.length}`,
      );
      for (const panel of moving.state.panels) {
        const name = `${label} ${panel.tone} panel "${panel.name}"`;
        // Static mode paints the sky into the panel instead of blurring what is behind it.
        check(
          panel.backdrop === (mode === "static" ? "none" : "blur(18px) saturate(1.7)"),
          `${name}: backdrop-filter ${panel.backdrop}`,
        );
        // The glass shadow: two inset sheen lines and the soft depth drop.
        check(
          panel.shadow.split("inset").length >= 3 && panel.shadow.includes("0px 22px 44px -28px"),
          `${name}: no glass shadow (${panel.shadow})`,
        );
        // Tone cues: a 1 px inset ring plus a glow on warning and failure panels only.
        const ringed = panel.tone === "warn" || panel.tone === "fail";
        check(
          panel.shadow.split("inset").length === (ringed ? 4 : 3),
          `${name}: tone ring ${ringed ? "missing" : "present"} (${panel.shadow})`,
        );
      }
      check(
        moving.state.perf?.mode === mode,
        `${label}: perf sampler mode ${moving.state.perf?.mode}`,
      );
      check(
        still.state.running.length === 0,
        `${label}: ${still.state.running.length} animations under reduced motion (${still.state.running.join(", ")})`,
      );
      if (mode !== "none")
        check(held === "paused", `${label}: scene did not hold after idle (${held})`);
      check(moving.errors.length + still.errors.length === 0, `${label}: page errors`);
      report[`${theme}-${mode}`] = {
        running_scene_animations: scene.length,
        reduced_motion_running: still.state.running,
        page_scroll: moving.state.pageScroll,
        dashboard_overflow: moving.state.dashboardOverflow,
        panels: moving.state.panels,
        perf: moving.state.perf,
      };
    }
  }
} finally {
  await browser.close();
}
report.failures = failures;
await writeFile(new URL("ambient-check.json", artifacts), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ origin, failures }, null, 2));
if (failures.length) process.exitCode = 1;
