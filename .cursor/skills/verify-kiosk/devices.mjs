#!/usr/bin/env node
// Devon's device matrix (MET-297): every page at every device viewport, both themes, then the
// topology "How … works" explanation on both iPhone orientations. Fails on page-level
// horizontal scroll, content past the viewport or the safe area, an unlisted inner scroller, a
// touch target under 44 px on touch devices, a contrast pair under AA, or explanation text
// that sits in a nested vertical scroller or cannot be reached. Full-page screenshots and
// devices-check.json go to DEVICES_OUT. Read-only: drives an already running kiosk.
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { auditContrast } from "./contrast.mjs";
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const { chromium } = createRequire(`${repo}kiosk/package.json`)("@playwright/test");
const NONE = { top: 0, right: 0, bottom: 0, left: 0 };
// CSS viewports with Safari's toolbars showing. iPhone insets are the Dynamic Island and home
// indicator; without `viewport-fit=cover` Safari letterboxes landscape to 932 − 2 × 59 px.
const DEVICES = [
  {
    name: "iphone-portrait",
    width: 430,
    height: 739,
    dpr: 3,
    touch: true,
    insets: { ...NONE, bottom: 34 },
  },
  {
    name: "iphone-landscape",
    width: 932,
    height: 380,
    dpr: 3,
    touch: true,
    insets: { top: 0, right: 59, bottom: 21, left: 59 },
  },
  { name: "ipad-portrait", width: 820, height: 1180, dpr: 2, touch: true, insets: NONE },
  { name: "ipad-landscape", width: 1180, height: 820, dpr: 2, touch: true, insets: NONE },
  { name: "macbook-14", width: 1512, height: 982, dpr: 2, touch: false, insets: NONE },
  { name: "monitor-27", width: 2560, height: 1440, dpr: 1, touch: false, insets: NONE },
  { name: "kiosk-console", width: 1728, height: 1117, dpr: 1, touch: false, insets: NONE },
];
const PAGES = ["/", "/ups", "/llm", "/network", "/devices/factory-gpu", "/topology"];
// Fixed-height boxes that scroll on purpose (styleguide, MET-296), plus React Flow's pane.
const SCROLLERS = [
  "[role=log]",
  ".verdict-items",
  ".service-detail",
  ".warning-slot",
  ".select-content",
  ".react-flow",
];
const base = process.env.BASE_URL ?? "http://127.0.0.1:4180";
const out =
  process.env.DEVICES_OUT ??
  (process.env.VERIFY_ROOT
    ? `${process.env.VERIFY_ROOT}/evidence/devices`
    : `${repo}.amp/in/artifacts/devices`);
const only = process.env.DEVICES?.split(",");
const themes = (process.env.THEMES ?? "dark,light").split(",");
const strict = process.env.DEVICES_STRICT !== "0";
const journeyOnly = process.env.JOURNEY_ONLY === "1";
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const reports = [];
const failures = [];
async function explanation(device, theme) {
  const name = `${device.name}-${theme}-topology-explanation`;
  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: device.dpr,
    isMobile: device.touch,
    hasTouch: device.touch,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/topology`);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: device.insets });
  await page.locator(".react-flow__node").first().waitFor();
  await page.getByRole("button", { name: "Linear dispatch", exact: true }).click();
  await page.getByRole("button", { name: "How linear dispatch works" }).click();
  await page.locator("#topology-steps").waitFor({ state: "visible" });
  await page.waitForTimeout(400);
  const result = await page.evaluate(() => {
    const box = document.getElementById("topology-steps");
    const label = (node) =>
      `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}.${String(node.className).split(" ")[0]} ${node.scrollHeight}/${node.clientHeight}`;
    // The box itself or any ancestor that clips or scrolls its text vertically.
    const nested = [];
    for (let node = box; node && node !== document.documentElement; node = node.parentElement) {
      const css = getComputedStyle(node);
      if (
        /(auto|scroll|hidden|clip)/.test(css.overflowY) &&
        node.scrollHeight > node.clientHeight + 1
      )
        nested.push(label(node));
    }
    for (const node of box.querySelectorAll("*")) {
      const css = getComputedStyle(node);
      if (/(auto|scroll)/.test(css.overflowY) && node.scrollHeight > node.clientHeight + 1)
        nested.push(label(node));
    }
    // Every heading, paragraph, step and legend line can be brought on screen by scrolling
    // the document and is the topmost element there (not under the sticky bar or clipped).
    const parts = [...box.querySelectorAll("h3, p, li, .topology-legend span")];
    const unreachable = [];
    for (const part of parts) {
      part.scrollIntoView({ block: "center", behavior: "instant" });
      const rect = part.getBoundingClientRect();
      const x = Math.min(innerWidth - 1, Math.max(0, rect.left + Math.min(rect.width / 2, 40)));
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (y < 0 || y > innerHeight || !hit || !(part === hit || part.contains(hit)))
        unreachable.push(
          `${part.tagName.toLowerCase()} "${(part.textContent ?? "").trim().slice(0, 40)}" at y ${Math.round(y)}`,
        );
    }
    scrollTo({ top: 0, behavior: "instant" });
    return {
      popover: box.hasAttribute("popover"),
      viewport: { width: innerWidth, height: innerHeight },
      scrollWidth: document.scrollingElement.scrollWidth,
      scrollHeight: document.scrollingElement.scrollHeight,
      parts: parts.length,
      nested,
      unreachable,
    };
  });
  const problems = [
    ...(result.viewport.width !== device.width
      ? [`layout viewport ${result.viewport.width} px, expected ${device.width} px`]
      : []),
    ...(result.scrollWidth > result.viewport.width
      ? [`page scrolls horizontally: ${result.scrollWidth} > ${result.viewport.width}`]
      : []),
    ...result.nested.map((entry) => `explanation in a nested vertical scroller: ${entry}`),
    ...result.unreachable.map((entry) => `explanation text not reachable: ${entry}`),
    ...errors.map((error) => `page error: ${error}`),
  ];
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  for (const problem of problems) failures.push(`${name}: ${problem}`);
  console.log(
    `${name}: ${result.viewport.width}×${result.viewport.height} doc ${result.scrollWidth}×${result.scrollHeight} ${result.parts} parts${problems.length ? ` — ${problems.length} problem(s)` : ""}`,
  );
  reports.push({
    name,
    device: device.name,
    theme,
    path: "/topology",
    journey: "explanation",
    ...result,
    problems,
  });
  await context.close();
}
// The document is the page scroller, so an in-app link must open its page at the top with the
// heading below the sticky bar, and Back/Forward must restore each page's own offset.
// `JOURNEY_ONLY=1` runs just this journey.
async function journey(device, theme) {
  const name = `${device.name}-${theme}-network-journey`;
  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: device.dpr,
    isMobile: device.touch,
    hasTouch: device.touch,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/`);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: device.insets });
  const card = page.locator('a.panel-link[href="/network"]');
  await card.waitFor();
  await card.evaluate((node) => node.scrollIntoView({ block: "center", behavior: "instant" }));
  await page.waitForTimeout(200);
  const where = () =>
    page.evaluate(() => {
      const bar = document.querySelector(".topbar").getBoundingClientRect();
      const title = document.querySelector("main .page-title").getBoundingClientRect();
      return {
        path: location.pathname,
        scrollY: Math.round(scrollY),
        heading: Math.round(title.top),
        bar: Math.round(bar.bottom),
        visible: title.top >= bar.bottom - 1 && title.bottom <= innerHeight,
        card: (() => {
          const link = document.querySelector('a.panel-link[href="/network"]');
          const rect = link?.getBoundingClientRect();
          return !!rect && rect.top < innerHeight && rect.bottom > bar.bottom;
        })(),
      };
    });
  const overview = await where();
  const steps = [];
  const problems = [];
  const atPage = async (step, path, check) => {
    await page.waitForFunction((want) => location.pathname === want, path);
    await page.waitForTimeout(300);
    const at = await where();
    steps.push({ step, ...at });
    const problem = check(at);
    if (problem)
      problems.push(
        `${step}: ${problem} (scrollY ${at.scrollY}, heading at ${at.heading} px, bar ends ${at.bar} px)`,
      );
  };
  const opensAtTop = (at) =>
    at.scrollY > 1 || !at.visible ? "heading not visible below the sticky bar" : "";
  if (overview.scrollY < 100)
    problems.push(`overview did not scroll to the card (scrollY ${overview.scrollY})`);
  if (device.touch) await card.tap();
  else await card.click();
  await atPage("tap Network", "/network", opensAtTop);
  // Leave /network part-way down so Forward has its own offset to restore.
  const left = await page.evaluate(() => {
    scrollTo({
      top: Math.min(240, document.scrollingElement.scrollHeight - innerHeight),
      behavior: "instant",
    });
    return Math.round(scrollY);
  });
  await page.goBack();
  await atPage("Back", "/", (at) =>
    at.scrollY < overview.scrollY / 2 || !at.card
      ? "overview did not return to the Network card"
      : "",
  );
  await page.goForward();
  await atPage("Forward", "/network", (at) =>
    Math.abs(at.scrollY - left) > 2
      ? `offset ${at.scrollY}, expected the ${left} it was left at`
      : "",
  );
  problems.push(...errors.map((error) => `page error: ${error}`));
  await page.screenshot({ path: `${out}/${name}.png` });
  for (const problem of problems) failures.push(`${name}: ${problem}`);
  console.log(
    `${name}: overview at ${overview.scrollY}; ${steps.map((s) => `${s.step} → ${s.path} scrollY ${s.scrollY} heading ${s.heading}`).join("; ")}${problems.length ? ` — ${problems.length} problem(s)` : ""}`,
  );
  reports.push({
    name,
    device: device.name,
    theme,
    path: "/",
    journey: "network",
    overview,
    steps,
    problems,
  });
  await context.close();
}
try {
  for (const device of DEVICES.filter((d) => !journeyOnly && (!only || only.includes(d.name))))
    for (const theme of themes) {
      const context = await browser.newContext({
        viewport: { width: device.width, height: device.height },
        deviceScaleFactor: device.dpr,
        isMobile: device.touch,
        hasTouch: device.touch,
        colorScheme: theme,
        reducedMotion: "reduce",
      });
      for (const path of PAGES) {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${base}${path}`);
        const cover = await page.evaluate(() =>
          /viewport-fit=cover/.test(
            document.querySelector("meta[name=viewport]")?.getAttribute("content") ?? "",
          ),
        );
        const insets = cover
          ? device.insets
          : { ...device.insets, left: 0, right: 0, top: 0, bottom: 0 };
        if (!cover && device.insets.left + device.insets.right > 0)
          await page.setViewportSize({
            width: device.width - device.insets.left - device.insets.right,
            height: device.height,
          });
        const cdp = await context.newCDPSession(page);
        await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets });
        await page.locator("main .panel").first().waitFor();
        if (path === "/topology") await page.locator(".react-flow__node").first().waitFor();
        await page
          .getByLabel("Loading section")
          .first()
          .waitFor({ state: "detached", timeout: 10_000 })
          .catch(() => {});
        await page.waitForTimeout(800);
        const name = `${device.name}-${theme}-${path === "/" ? "overview" : path.slice(1).replaceAll("/", "-")}`;
        const layout = await page.evaluate(
          ({ insets, touch, scrollers }) => {
            const viewport = { width: innerWidth, height: innerHeight };
            const scrolling = document.scrollingElement;
            const visible = (element) => {
              if (
                element.closest(
                  ".fk-backdrop, svg, [hidden], .skip-link, #recharts_measurement_span",
                )
              )
                return false;
              const css = getComputedStyle(element);
              if (css.visibility === "hidden" || css.display === "none") return false;
              const rect = element.getBoundingClientRect();
              return rect.width > 0.5 && rect.height > 0.5;
            };
            const label = (element) =>
              `${element.tagName.toLowerCase()}${element.className && typeof element.className === "string" ? "." + element.className.trim().split(/\s+/).slice(0, 2).join(".") : ""} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 30)}"`;
            // Inside an element that scrolls or clips horizontally on purpose (tables, React Flow).
            const clippedX = (element) => {
              for (
                let node = element.parentElement;
                node && node !== document.body;
                node = node.parentElement
              ) {
                const overflow = getComputedStyle(node).overflowX;
                if (overflow !== "visible") return true;
              }
              return false;
            };
            const outside = [];
            const safe = [];
            let minFont = Infinity;
            let minFontText = "";
            for (const element of document.querySelectorAll("body *")) {
              if (!visible(element)) continue;
              const hasText = [...element.childNodes].some(
                (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
              );
              const rect = element.getBoundingClientRect();
              if (!clippedX(element) && (rect.right > viewport.width + 1 || rect.left < -1))
                outside.push(
                  `${label(element)} ${Math.round(rect.left)}–${Math.round(rect.right)}`,
                );
              if (!hasText || clippedX(element)) continue;
              const size = parseFloat(getComputedStyle(element).fontSize);
              if (size < minFont) {
                minFont = size;
                minFontText = label(element);
              }
              if (rect.left < insets.left - 0.5 || rect.right > viewport.width - insets.right + 0.5)
                safe.push(`${label(element)} x ${Math.round(rect.left)}–${Math.round(rect.right)}`);
            }
            // The last content must clear the home indicator at the end of the document.
            const footer = document.querySelector(".version-footer");
            if (footer) {
              const padding = parseFloat(getComputedStyle(footer).paddingBottom);
              if (insets.bottom && padding < insets.bottom)
                safe.push(`footer padding-bottom ${padding} < ${insets.bottom}`);
            }
            const inner = [];
            for (const element of document.querySelectorAll("body *")) {
              const css = getComputedStyle(element);
              if (!/(auto|scroll)/.test(css.overflowY)) continue;
              if (element.scrollHeight <= element.clientHeight + 1) continue;
              if (scrollers.some((selector) => element.closest(selector))) continue;
              inner.push(`${label(element)} ${element.scrollHeight}/${element.clientHeight}`);
            }
            const small = [];
            if (touch)
              for (const element of document.querySelectorAll(
                'a[href], button, input, select, textarea, [role="button"], [role="combobox"]',
              )) {
                if (!visible(element)) continue;
                // Inline links in running text are exempt (WCAG 2.5.8), as are visually hidden
                // form inputs (Base UI's select value) and React Flow's attribution.
                if (element.closest("p, .react-flow__attribution, [aria-hidden=true]")) continue;
                const rect = element.getBoundingClientRect();
                if (rect.width < 44 || rect.height < 44)
                  small.push(
                    `${label(element)} ${Math.round(rect.width)}×${Math.round(rect.height)}`,
                  );
              }
            const panels = [...document.querySelectorAll("main .panel")]
              .filter(visible)
              .map((panel) => panel.getBoundingClientRect());
            const used = panels.length
              ? (Math.max(...panels.map((r) => r.right)) - Math.min(...panels.map((r) => r.left))) /
                viewport.width
              : 0;
            return {
              viewport,
              scrollWidth: scrolling.scrollWidth,
              scrollHeight: scrolling.scrollHeight,
              widthUsed: Math.round(used * 1000) / 1000,
              minFont,
              minFontText,
              outside,
              safe,
              inner,
              small,
            };
          },
          { insets, touch: device.touch, scrollers: SCROLLERS },
        );
        await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
        const expected = cover
          ? device.width
          : device.width - device.insets.left - device.insets.right;
        const problems = [
          // A mobile browser widens the layout viewport (zooms out) when content is too wide.
          ...(layout.viewport.width !== expected
            ? [`layout viewport ${layout.viewport.width} px, expected ${expected} px`]
            : []),
          ...(layout.scrollWidth > layout.viewport.width
            ? [`page scrolls horizontally: ${layout.scrollWidth} > ${layout.viewport.width}`]
            : []),
          ...layout.outside.map((entry) => `past the viewport: ${entry}`),
          ...layout.safe.map((entry) => `outside the safe area: ${entry}`),
          ...layout.inner.map((entry) => `inner scroller: ${entry}`),
          ...layout.small.map((entry) => `touch target under 44 px: ${entry}`),
          ...errors.map((error) => `page error: ${error}`),
        ];
        let contrast;
        try {
          contrast = await auditContrast(page, name);
        } catch (error) {
          problems.push(error.message);
        }
        for (const problem of problems) failures.push(`${name}: ${problem}`);
        console.log(
          `${name}: ${layout.viewport.width}×${layout.viewport.height} doc ${layout.scrollWidth}×${layout.scrollHeight} width used ${layout.widthUsed} min font ${layout.minFont}px${problems.length ? ` — ${problems.length} problem(s)` : ""}`,
        );
        reports.push({
          name,
          device: device.name,
          theme,
          path,
          cover,
          insets,
          ...layout,
          contrast,
          problems,
        });
        await page.close();
      }
      await context.close();
    }
  // The topology explanation on a phone: select Linear dispatch, open "How … works" and
  // require every step to be reachable by scrolling the document, never an inner scroller.
  for (const device of DEVICES.filter(
    (d) => !journeyOnly && d.name.startsWith("iphone") && (!only || only.includes(d.name)),
  ))
    for (const theme of themes) await explanation(device, theme);
  // Overview → Network card → Back → Forward on the iPhone and iPad, both orientations.
  for (const device of DEVICES.filter((d) => d.touch && (!only || only.includes(d.name))))
    await journey(device, themes[0]);
} finally {
  await browser.close();
  await writeFile(
    `${out}/devices-check.json`,
    JSON.stringify({ reports, failures }, null, 2) + "\n",
  );
}
if (failures.length) {
  console.log(failures.join("\n"));
  if (strict) process.exit(1);
}
console.log(
  `Device matrix: ${reports.length} captures (pages × viewports × themes, plus the topology explanation), ${failures.length} problem(s).`,
);
