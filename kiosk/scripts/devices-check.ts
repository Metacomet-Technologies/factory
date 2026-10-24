// Devon's device matrix (MET-297): every page at every device viewport, both themes.
// Fails on page-level horizontal scroll, content past the viewport or the safe area, an
// unlisted inner scroller, a touch target under 44 px on touch devices, or a contrast pair
// under AA. Screenshots and devices-check.json go to DEVICES_OUT.
import { mkdir, writeFile } from "node:fs/promises";
import { auditContrast } from "./contrast.ts";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= `${process.cwd()}/.browsers`;
const { chromium } = await import("@playwright/test");

type Insets = { top: number; right: number; bottom: number; left: number };
const NONE: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
// CSS viewports with Safari's toolbars showing. iPhone insets are the Dynamic Island and home
// indicator; without `viewport-fit=cover` Safari letterboxes landscape to 932 − 2 × 59 px.
export const DEVICES = [
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
] as const;
export const PAGES = ["/", "/ups", "/llm", "/network", "/devices/factory-gpu", "/topology"];
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
const out = process.env.DEVICES_OUT ?? "../.amp/in/artifacts/devices";
const only = process.env.DEVICES?.split(",");
const themes = (process.env.THEMES ?? "dark,light").split(",") as ("dark" | "light")[];
const strict = process.env.DEVICES_STRICT !== "0";
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const reports: unknown[] = [];
const failures: string[] = [];

try {
  for (const device of DEVICES.filter((d) => !only || only.includes(d.name)))
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
        const errors: string[] = [];
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
            const scrolling = document.scrollingElement!;
            const visible = (element: Element) => {
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
            const label = (element: Element) =>
              `${element.tagName.toLowerCase()}${element.className && typeof element.className === "string" ? "." + element.className.trim().split(/\s+/).slice(0, 2).join(".") : ""} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 30)}"`;
            // Inside an element that scrolls or clips horizontally on purpose (tables, React Flow).
            const clippedX = (element: Element) => {
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
            const outside: string[] = [];
            const safe: string[] = [];
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
            const inner: string[] = [];
            for (const element of document.querySelectorAll("body *")) {
              const css = getComputedStyle(element);
              if (!/(auto|scroll)/.test(css.overflowY)) continue;
              if (element.scrollHeight <= element.clientHeight + 1) continue;
              if (scrollers.some((selector) => element.closest(selector))) continue;
              inner.push(`${label(element)} ${element.scrollHeight}/${element.clientHeight}`);
            }
            const small: string[] = [];
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
          problems.push((error as Error).message);
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
  `Device matrix: ${reports.length} page × viewport × theme captures, ${failures.length} problem(s).`,
);
