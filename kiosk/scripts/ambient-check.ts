import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// MET-237: the ambient spike at the kiosk size, per mode and theme. Origin: AMBIENT_ORIGIN,
// else this worktree's sandbox, else the mock preview (`vp run mock-preview`).
// AMBIENT_BASELINE_ORIGIN, when set, is a build of main against the same API; the default
// URL must then match it exactly. Every origin except the sandbox (whose synthetic data is
// healthy) must show plain, warning and failure panels, as `MOCK_NETWORK=down` does.
const root = new URL("../../", import.meta.url);
const ports = new URL(".sandbox/ports.json", root);
const sandbox = existsSync(ports)
  ? `http://127.0.0.1:${(JSON.parse(await readFile(ports, "utf8")) as { "factory-api": number })["factory-api"]}`
  : undefined;
const origin = process.env.AMBIENT_ORIGIN ?? sandbox ?? "http://127.0.0.1:4180";
const requireTones = origin !== sandbox;
const baseline = process.env.AMBIENT_BASELINE_ORIGIN;
const artifacts = new URL(".amp/in/artifacts/ambient/", root);
await mkdir(artifacts, { recursive: true });
process.env.PLAYWRIGHT_BROWSERS_PATH ??= `${process.cwd()}/.browsers`;
const { chromium } = await import("@playwright/test");
const browser = await chromium.launch();

const modes = ["both", "sweep", "none", "static"] as const;
const themes = ["dark", "light"] as const;
type Theme = (typeof themes)[number];
const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};
// Live sandbox data flips these between loads: an alarm's pulsing dot, and the request
// ticker before and after its first row. Any other class difference fails.
const dataStates = new Set(["chip-dot-pulse", "ticker", "empty"]);
const sameClasses = (a: string[], b: string[], message: string) => {
  const left = a.filter((name) => !b.includes(name));
  const right = b.filter((name) => !a.includes(name));
  const ignored = [...left, ...right].filter((name) => dataStates.has(name));
  if (ignored.length) console.log(`${message}: ignored live-data classes ${ignored.join(" ")}`);
  check(
    [...left, ...right].every((name) => dataStates.has(name)),
    `${message}: only left ${left.join(" ")}; only right ${right.join(" ")}`,
  );
};

/** Loads a URL, lets the panels finish their entrance, and reads what the checks need. */
async function visit(base: string, query: string, theme: Theme, reducedMotion = false) {
  const page = await browser.newPage({
    viewport: { width: 1728, height: 1117 },
    colorScheme: theme,
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
  });
  const errors: string[] = [];
  const paths = new Set<string>();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol.startsWith("http"))
      // Build hashes differ between this branch and main; compare the asset names only.
      paths.add(
        `${url.origin === base ? "" : url.origin}${url.pathname.replace(/-[\w-]{8}\.(js|css)$/, ".$1")}`,
      );
  });
  await page.goto(`${base}/${query}`);
  await page.getByRole("region", { name: "Fleet" }).waitFor();
  await page.waitForTimeout(2500);
  const state = await page.evaluate(() => {
    const classes = new Set<string>();
    for (const element of document.querySelectorAll("*"))
      for (const name of element.classList) classes.add(name);
    const dashboard = document.querySelector(".dashboard");
    return {
      classes: [...classes].sort(),
      ambientAttribute: document.documentElement.dataset.ambient ?? null,
      sceneElements: document.querySelectorAll(".fk-backdrop, [data-ambient-scene]").length,
      panels: [...document.querySelectorAll<HTMLElement>(".panel")].map((panel, i) => {
        const style = getComputedStyle(panel);
        return {
          name: panel.getAttribute("aria-label") ?? `panel ${i}`,
          tone: panel.dataset.tone ?? "plain",
          background: style.backgroundColor,
          backdrop: style.backdropFilter,
          radius: style.borderRadius,
          border: style.borderTopColor,
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
      running: document
        .getAnimations()
        .filter((animation) => animation.playState === "running")
        .map((animation) =>
          animation instanceof CSSAnimation ? animation.animationName : animation.constructor.name,
        ),
      perf: (window as { __ambientPerf?: { mode: string } }).__ambientPerf ?? null,
    };
  });
  return { page, state, errors, paths: [...paths].sort() };
}

const report: Record<string, unknown> = { origin, baseline: baseline ?? null };
try {
  for (const theme of themes) {
    // Default URL: no scene, no v2 styling, and the same DOM classes for unknown modes.
    const v1 = await visit(origin, "", theme);
    await v1.page.screenshot({ path: fileURLToPath(new URL(`1728-${theme}-v1.png`, artifacts)) });
    await v1.page.close();
    check(v1.state.ambientAttribute === null, `${theme} default: data-ambient is set`);
    check(v1.state.sceneElements === 0, `${theme} default: scene elements present`);
    check(
      !v1.state.classes.some((name) => name.startsWith("fk-")),
      `${theme} default: fk- classes present`,
    );
    check(v1.errors.length === 0, `${theme} default: page errors ${v1.errors.join("; ")}`);
    for (const query of ["?ambient=stars", "?perf=1"]) {
      const same = await visit(origin, query, theme);
      await same.page.close();
      sameClasses(
        same.state.classes,
        v1.state.classes,
        `${theme} ${query}: DOM classes differ from the default URL`,
      );
      check(
        JSON.stringify(same.state.panels) === JSON.stringify(v1.state.panels),
        `${theme} ${query}: panel styles differ from the default URL`,
      );
      check(same.state.sceneElements === 0, `${theme} ${query}: scene elements present`);
      if (query === "?perf=1")
        check(same.state.perf?.mode === "v1", `${theme} ?perf=1: no v1 perf sampler`);
    }
    check(v1.state.perf === null, `${theme} default: perf sampler running without ?perf=1`);
    if (baseline) {
      const main = await visit(baseline, "", theme);
      await main.page.close();
      sameClasses(
        main.state.classes,
        v1.state.classes,
        `${theme} default: DOM classes differ from main (${baseline})`,
      );
      check(
        JSON.stringify(main.state.panels) === JSON.stringify(v1.state.panels),
        `${theme} default: panel styles differ from main`,
      );
      check(
        JSON.stringify(main.paths) === JSON.stringify(v1.paths),
        `${theme} default: request paths differ from main`,
      );
      report[`${theme}-main`] = { classes: main.state.classes.length, paths: main.paths };
    }
    report[`${theme}-v1`] = { ...v1.state, classes: v1.state.classes.length, paths: v1.paths };
    const tones = new Set(v1.state.panels.map((panel) => panel.tone));
    if (requireTones)
      for (const tone of ["plain", "warn", "fail"])
        check(tones.has(tone), `${theme} default: no ${tone} panel to check (populated mock?)`);

    for (const mode of modes) {
      const label = `${theme} ${mode}`;
      const moving = await visit(origin, `?ambient=${mode}&perf=1`, theme);
      await moving.page.screenshot({
        path: fileURLToPath(new URL(`1728-${theme}-${mode}.png`, artifacts)),
      });
      await moving.page.close();
      const still = await visit(origin, `?ambient=${mode}`, theme, true);
      await still.page.screenshot({
        path: fileURLToPath(new URL(`1728-${theme}-${mode}-reduced.png`, artifacts)),
      });
      await still.page.close();
      const scene = moving.state.running.filter((name) => name.startsWith("fk-"));
      const expected =
        mode === "none"
          ? 0
          : mode === "both" && theme === "dark"
            ? 53 // sweep, two aurora ellipses, 50 stars
            : 1; // sweep only; stars and aurora are night-only
      const { scrollHeight, scrollWidth, innerHeight, innerWidth } = moving.state.pageScroll;
      check(moving.state.ambientAttribute === mode, `${label}: data-ambient is not ${mode}`);
      check(moving.state.sceneElements > 0, `${label}: no scene`);
      check(
        scene.length === expected,
        `${label}: ${scene.length} scene animations, expected ${expected}`,
      );
      check(
        scrollHeight <= innerHeight && scrollWidth <= innerWidth,
        `${label}: page scrolls (${scrollWidth}×${scrollHeight})`,
      );
      check(
        moving.state.dashboardOverflow === v1.state.dashboardOverflow,
        `${label}: dashboard overflow ${moving.state.dashboardOverflow} differs from v1 ${v1.state.dashboardOverflow}`,
      );
      check(
        moving.state.panels.length === v1.state.panels.length,
        `${label}: ${moving.state.panels.length} panels, v1 has ${v1.state.panels.length}`,
      );
      for (const panel of moving.state.panels) {
        const plain = v1.state.panels.find((other) => other.name === panel.name);
        const name = `${label} ${panel.tone} panel "${panel.name}"`;
        check(
          panel.backdrop === (mode === "static" ? "none" : "blur(18px) saturate(1.7)"),
          `${name}: backdrop-filter ${panel.backdrop}`,
        );
        // The glass shadow: two inset sheen lines and the soft depth drop.
        check(
          panel.shadow.split("inset").length === 3 && panel.shadow.includes("0px 22px 44px -28px"),
          `${name}: no glass shadow (${panel.shadow})`,
        );
        // Tone cues: v1's 3 px ring and tone border on warning and failure panels only.
        check(
          panel.shadow.includes("0px 0px 0px 3px") === (panel.tone !== "plain"),
          `${name}: tone ring ${panel.tone === "plain" ? "present" : "missing"}`,
        );
        if (panel.tone !== "plain")
          check(
            panel.tone === plain?.tone && panel.border === plain.border,
            `${name}: border ${panel.border}, v1 ${plain?.border}`,
          );
      }
      check(
        moving.state.perf?.mode === mode,
        `${label}: perf sampler mode ${moving.state.perf?.mode}`,
      );
      check(
        moving.paths.every((path) => v1.paths.includes(path)),
        `${label}: new requests ${moving.paths.filter((path) => !v1.paths.includes(path)).join(", ")}`,
      );
      check(
        still.state.running.length === 0,
        `${label}: ${still.state.running.length} animations under reduced motion`,
      );
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
console.log(JSON.stringify({ origin, baseline: baseline ?? null, failures }, null, 2));
if (failures.length) process.exitCode = 1;
