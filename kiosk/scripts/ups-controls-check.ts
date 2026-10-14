import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ControlState } from "../src/api/ups-control.ts";

// Only this worktree's isolated stack and local kiosk preview are used.
const root = new URL("../../", import.meta.url);
const ports = JSON.parse(await readFile(new URL(".sandbox/ports.json", root), "utf8")) as {
  "factory-api": number;
  "fake-serve": number;
};
const origin = "http://127.0.0.1:14168";
const artifacts = new URL(".amp/in/artifacts/", root);
await mkdir(artifacts, { recursive: true });
const { chromium, expect } = await import("@playwright/test");
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  colorScheme: "dark",
  timezoneId: "America/New_York",
});
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const reports: unknown[] = [];
const login = (value: string) => writeFile(new URL(".sandbox/serve-login", root), value);
const controls = page.getByRole("region", { name: "Controls", exact: true });
const capture = (name: string) =>
  page.screenshot({ path: fileURLToPath(new URL(name, artifacts)), animations: "disabled" });
async function contrast() {
  const minimum = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const luminance = (pixels: Uint8ClampedArray) => {
      const channels = [...pixels].slice(0, 3).map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
    };
    return Math.min(
      ...[
        ...document.querySelectorAll<HTMLElement>(
          ".ups-controls p, .ups-controls label, .ups-controls button:not(:disabled), .ups-confirm p, .ups-confirm label, .ups-confirm button:not(:disabled)",
        ),
      ].map((element) => {
        const ancestors: HTMLElement[] = [];
        for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement)
          ancestors.unshift(parent);
        context.clearRect(0, 0, 1, 1);
        for (const ancestor of ancestors) {
          context.fillStyle = getComputedStyle(ancestor).backgroundColor;
          context.fillRect(0, 0, 1, 1);
        }
        const background = luminance(context.getImageData(0, 0, 1, 1).data);
        context.fillStyle = getComputedStyle(element).color;
        context.fillRect(0, 0, 1, 1);
        const foreground = luminance(context.getImageData(0, 0, 1, 1).data);
        return (
          (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05)
        );
      }),
    );
  });
  expect(minimum).toBeGreaterThanOrEqual(4.5);
  reports.push({
    theme: await page.locator("html").getAttribute("data-theme"),
    minimumTextContrast: minimum,
  });
}
async function complete(name: string, value?: string) {
  if (value) await controls.getByLabel(name, { exact: true }).selectOption(value);
  await controls
    .getByRole("button", { name: value ? `Review ${name}` : name, exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const phrase = await dialog.locator("label strong").innerText();
  const input = dialog.getByRole("textbox");
  const confirm = dialog.getByRole("button", { name: "Confirm", exact: true });
  await input.fill(`${phrase} `);
  await expect(confirm).toBeDisabled();
  await input.fill(phrase);
  await expect(confirm).toBeEnabled();
  // Exercise real keyboard focus containment, not only the library's DOM.
  await input.focus();
  for (let index = 0; index < 6; index++) {
    await page.keyboard.press("Tab");
    await expect
      .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true);
  }
  if (name === "power.cycle") {
    await expect(dialog).toContainText("factory-gpu, modem and eero go down");
    await expect(dialog).toContainText("this page will disconnect");
    await contrast();
    await capture("390-light-power-confirm.png");
  }
  const result = page.waitForResponse(
    (response) => response.url().endsWith("/confirm") && response.request().method() === "POST",
  );
  await confirm.click();
  const response = await result;
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { result: string; tracking_status: string };
  reports.push({ action: name, value: value ?? null, ...body });
  await expect(dialog).not.toBeVisible();
  await expect(controls.locator(".ups-control-result")).toContainText(body.result);
  return body;
}
try {
  await login("DGarbs51@github");
  await page.goto(`${origin}/ups`);
  await expect(controls.getByRole("button", { name: "test.quick", exact: true })).toBeVisible();
  await expect(
    controls.getByRole("button", { name: "power.off_stay", exact: true }),
  ).toBeDisabled();
  await expect(controls).toContainText("Disabled: the final NUT shutdown hook");
  expect((await complete("test.quick")).tracking_status).toBe("SUCCESS");
  expect((await complete("input.sensitivity", "high")).tracking_status).toBe("SUCCESS");
  await expect(controls.getByLabel("input.sensitivity", { exact: true })).toHaveValue("high");
  await expect(controls.locator(".ups-control-audit")).toContainText("input.sensitivity · high");
  await contrast();
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    scrollTo(0, 0);
  });
  const bounds = await controls.boundingBox();
  expect(bounds).not.toBeNull();
  await page.screenshot({
    path: fileURLToPath(new URL("390-dark-ups-controls.png", artifacts)),
    clip: bounds!,
    fullPage: true,
    animations: "disabled",
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect((await complete("power.cycle")).tracking_status).toBe("FSD_SET");
  await expect(page.getByText("Factory going down; return time unavailable")).toBeVisible();
  await page
    .locator(".ups-pending")
    .evaluate((element) => scrollTo(0, element.getBoundingClientRect().top + scrollY - 100));
  await capture("390-light-ups-pending.png");
  // The fake never shuts down. Simulate only browser health transport down/up.
  await page.route("**/v1/health", (route) => route.fulfill({ status: 503, body: "{}" }));
  await page.waitForTimeout(6000);
  await page.unroute("**/v1/health");
  await expect(page.getByText("Factory going down; return time unavailable")).not.toBeVisible({
    timeout: 12_000,
  });
  const snapshot = (await (
    await fetch(`http://127.0.0.1:${ports["fake-serve"]}/control/v1/state`)
  ).json()) as ControlState;
  expect(
    snapshot.audit.some(
      (row) => row.action === "test.quick" && row.result === "executed: driver tracking SUCCESS",
    ),
  ).toBe(true);
  expect(
    snapshot.audit.some(
      (row) =>
        row.action === "input.sensitivity" &&
        row.value === "high" &&
        row.result === "executed: driver tracking SUCCESS",
    ),
  ).toBe(true);
  expect(snapshot.pending_power_action?.action).toBe("power.cycle");
  const mutations = (await readFile(new URL(".sandbox/ups-received.log", root), "utf8"))
    .split("\n")
    .filter((line) => /^(FSD|INSTCMD|SET VAR|SET TRACKING|GET TRACKING)\b/.test(line));
  expect(mutations).toContain("FSD cyberpower");
  reports.push({
    mutations,
    audit: snapshot.audit,
    recovery: "Browser-only health 503 then real sandbox 200; no physical outage",
  });
  await login("unlisted@github");
  await page.setViewportSize({ width: 1728, height: 1117 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await expect(controls).toHaveText("Controls available from Devon's or David's devices");
  await expect(controls.getByRole("button")).toHaveCount(0);
  await controls.scrollIntoViewIfNeeded();
  await capture("1728-dark-ups-controls-denied.png");
  expect(errors).toEqual([]);
  await writeFile(
    new URL("ups-controls-check.json", artifacts),
    JSON.stringify({ reports, errors }, null, 2),
  );
  console.log(
    "UPS controls sandbox: quick test SUCCESS, sensitivity high SUCCESS, FSD_SET; denied view, exact phrase, keyboard trap, health recovery and captures passed.",
  );
} finally {
  await login("DGarbs51@github");
  await browser.close();
}
