// Deploy render check: open every kiosk page in headless Chromium and require the app to
// render. version.json only proves the files were installed; a bundle that crashes on load
// (two Reacts once blanked every page with "reading 'useMemo'") still serves it.
// Usage: node scripts/render-check.ts [origin]   (default http://127.0.0.1:8080)
const { chromium } = await import("@playwright/test");

const origin = process.argv[2] ?? "http://127.0.0.1:8080";
const pages = ["/", "/llm", "/topology", "/network", "/ups", "/devices/factory-gpu"];
const browser = await chromium.launch();
const failures: string[] = [];
try {
  for (const path of pages) {
    const page = await browser.newPage({ viewport: { width: 1728, height: 1117 } });
    // Uncaught exceptions only: a failed API request (the UPS control state is optional) is
    // the app's own business, not a broken bundle.
    const errors: string[] = [];
    // The first uncaught error ends the wait for this page instead of its 20 s timeout.
    const crashed = new Promise<never>((_, reject) =>
      page.on("pageerror", (error) => {
        errors.push(error.message);
        reject(new Error("crashed"));
      }),
    );
    crashed.catch(() => {});
    try {
      const rendered = async () => {
        await page.goto(origin + path, { waitUntil: "load", timeout: 20_000 });
        await page
          .getByRole("heading", { level: 1, name: "factory", exact: true })
          .waitFor({ timeout: 20_000 });
        await page.waitForFunction(
          () => (document.querySelector("main#main")?.textContent ?? "").trim().length > 0,
          null,
          { timeout: 20_000 },
        );
        // Errors thrown after the first paint (a lazy chunk, a later effect) still count.
        await page.waitForTimeout(1000);
      };
      await Promise.race([rendered(), crashed]);
      console.log(`rendered ${path}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      failures.push(`${path}: ${errors.length ? errors.join("; ") : reason}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
if (failures.length) {
  console.error(`kiosk did not render at ${origin}:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`kiosk rendered ${pages.length} pages at ${origin}`);
