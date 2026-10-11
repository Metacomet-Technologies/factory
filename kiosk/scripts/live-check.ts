import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { StreamEvent, Usage } from "../src/api/types.ts";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= `${process.cwd()}/.browsers`;
const { chromium, expect } = await import("@playwright/test");
const origin = process.env.KIOSK_PREVIEW_URL ?? "http://127.0.0.1:14180";
const browser = await chromium.launch();
const errors: string[] = [];
const reports: unknown[] = [];
const raw: Buffer[] = [];
let capture: ReturnType<typeof spawn> | undefined;
await mkdir("screenshots", { recursive: true });
const usage = async () => {
  const response = await fetch(`${origin}/v1/llm/usage`);
  if (!response.ok) throw new Error(`Usage HTTP ${response.status}`);
  return (await response.json()) as Usage;
};
try {
  const before = await usage();
  const pages = [];
  for (const [width, height] of [
    [1728, 1117],
    [1024, 768],
    [390, 844],
  ] as const) {
    const page = await browser.newPage({
      viewport: { width, height },
      colorScheme: "dark",
      reducedMotion: "reduce",
      timezoneId: "America/New_York",
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const NativeSource = window.EventSource;
      const events: unknown[] = [];
      Object.assign(window, { liveEvents: events });
      window.EventSource = class extends NativeSource {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options);
          for (const type of ["gpu.sample", "llm.request"])
            this.addEventListener(type, (message: MessageEvent<string>) =>
              events.push(JSON.parse(message.data)),
            );
        }
      };
    });
    await page.goto(`${origin}/?kiosk`);
    // The API flushes SSE headers with its first sample/keepalive (up to 15s).
    await expect(page.getByText("Live", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("region", { name: "Local LLM" })).toContainText("factory-assist");
    pages.push({ page, width, height });
  }
  capture = spawn("curl", ["-sN", "--max-time", "60", "http://127.0.0.1:8080/v1/stream"]);
  capture.stdout!.on("data", (chunk: Buffer) => raw.push(chunk));
  const captured = new Promise<void>((resolve, reject) => {
    capture!.on("error", reject);
    capture!.on("exit", (code) =>
      code === 0 || code === 28 ? resolve() : reject(new Error(`curl: ${code}`)),
    );
  });
  const traffic: {
    model: string;
    prompt_eval_count: number;
    eval_count: number;
    total_duration: number;
    load_duration: unknown;
  }[] = [];
  for (const prompt of [
    "Say hello in three words.",
    "What is 2 plus 3? Be brief.",
    "Name one primary color.",
    "Name one weekday.",
  ]) {
    const response = await fetch("http://factory-gpu:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "factory-assist",
        prompt,
        stream: false,
        options: { num_predict: 24 },
      }),
    });
    if (!response.ok) throw new Error(`Generate HTTP ${response.status}`);
    const result = (await response.json()) as Record<string, unknown>;
    if (result.done !== true) throw new Error("Generation did not complete");
    const { model, prompt_eval_count, eval_count, total_duration, load_duration } = result;
    if (
      typeof model !== "string" ||
      typeof prompt_eval_count !== "number" ||
      typeof eval_count !== "number" ||
      typeof total_duration !== "number"
    )
      throw new Error("Generation usage missing");
    traffic.push({ model, prompt_eval_count, eval_count, total_duration, load_duration });
    console.log(`Completed verification request ${traffic.length}: ${eval_count} output tokens.`);
  }
  for (const { page, width, height } of pages) {
    // Other tailnet clients can generate concurrently. Match our completions,
    // rather than assuming the live service is an isolated test fixture.
    await expect
      .poll(
        async () => {
          const events = await page.evaluate(
            () => (window as unknown as { liveEvents: StreamEvent[] }).liveEvents,
          );
          return traffic.filter((request) =>
            events.some(
              (event) =>
                event.type === "llm.request" &&
                event.data.model === request.model &&
                event.data.prompt_tokens === request.prompt_eval_count &&
                event.data.output_tokens === request.eval_count &&
                Math.abs(event.data.latency_ms - request.total_duration / 1_000_000) < 0.01,
            ),
          ).length;
        },
        { timeout: 45_000 },
      )
      .toBe(4);
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (window as unknown as { liveEvents: { type: string }[] }).liveEvents.filter(
              (event) => event.type === "gpu.sample",
            ).length,
        ),
      )
      .toBeGreaterThan(0);
    await expect
      .poll(
        async () =>
          Number(
            await page
              .getByRole("region", { name: "Local LLM" })
              .locator(".usage-metrics .metric-value")
              .first()
              .textContent(),
          ),
        { timeout: 75_000 },
      )
      .toBeGreaterThanOrEqual(before.totals.requests + 4);
    const events = await page.evaluate(
      () => (window as unknown as { liveEvents: StreamEvent[] }).liveEvents,
    );
    const sample = events.filter((event) => event.type === "gpu.sample").at(-1);
    if (!sample?.data) throw new Error("No real GPU sample");
    const format = (value: number, unit: string) =>
      `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value)} ${unit}`;
    await expect(page.getByRole("region", { name: "GPU" })).toContainText(
      format(sample.data.utilization_percent, "%"),
    );
    await expect(page.getByRole("region", { name: "GPU" })).toContainText(
      format(sample.data.power_w, "W"),
    );
    await expect(page.getByRole("log")).toContainText("factory-assist");
    const layout = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));
    if (layout.width > width || (width === 1728 && layout.height > height))
      throw new Error(`Overflow at ${width}: ${JSON.stringify(layout)}`);
    if (width === 390) {
      await expect(page.locator(".model-cards")).toBeVisible();
      await expect(page.locator(".model-table")).toBeHidden();
    }
    await page.screenshot({ path: `screenshots/live-${width}-dark.png` });
    if (width !== 1728)
      await page.screenshot({ path: `screenshots/live-${width}-dark-full.png`, fullPage: true });
    reports.push({ width, height, layout, events });
  }
  const after = await usage();
  if (
    after.totals.requests < before.totals.requests + 4 ||
    after.totals.prompt_tokens <
      before.totals.prompt_tokens +
        traffic.reduce((sum, request) => sum + request.prompt_eval_count, 0) ||
    after.totals.output_tokens <
      before.totals.output_tokens + traffic.reduce((sum, request) => sum + request.eval_count, 0)
  )
    throw new Error("Real usage did not increase");
  await captured;
  if (errors.length) throw new Error(errors.join("; "));
  await writeFile(
    "screenshots/live-checks.json",
    JSON.stringify({ before, after, traffic, reports, errors }, null, 2) + "\n",
  );
  await writeFile("screenshots/live-stream.txt", Buffer.concat(raw));
  console.log(
    `Real SSE, ticker, GPU, usage and layouts passed: ${before.totals.requests} to ${after.totals.requests} requests.`,
  );
} finally {
  await browser.close();
  if (capture?.exitCode === null) capture.kill();
}
