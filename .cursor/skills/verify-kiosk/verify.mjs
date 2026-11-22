#!/usr/bin/env node
// Verification harness for the factory kiosk mock-dev stack.
// Kills only the process group recorded by `launch`. Leaves evidence in place.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const kiosk = fileURLToPath(new URL("../../../kiosk", import.meta.url));
const root = process.env.VERIFY_ROOT;
if (!root) {
  console.error("VERIFY_ROOT is required, for example /tmp/factory-kiosk-verify/$RUN_ID");
  process.exit(1);
}
const runDir = `${root}/run`;
const evidenceDir = `${root}/evidence`;
const pidFile = `${runDir}/pid`;
const logFile = `${runDir}/mock-dev.log`;
const mockPort = 4179;
const uiPort = 4181;

const command = process.argv[2];

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, timeout: 2000 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

function portPids(port) {
  const text = readFileSync("/proc/net/tcp", "utf8");
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set();
  for (const line of text.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;
    if ((parts[1] ?? "").endsWith(`:${hex}`) && parts[3] === "0A") inodes.add(parts[9]);
  }
  if (inodes.size === 0) return [];
  const owners = [];
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    let fds;
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (match && inodes.has(match[1])) owners.push(Number(pid));
      } catch {
        // fd vanished or is not a socket
      }
    }
  }
  return [...new Set(owners)];
}

function readPid() {
  if (!existsSync(pidFile)) throw new Error(`no pid file at ${pidFile}`);
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`bad pid in ${pidFile}`);
  return pid;
}

// Ready means both servers answer, not a log line: with CI set, vite colors the URL it prints.
async function waitReady(pid) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (!existsSync(`/proc/${pid}`)) throw new Error("mock-dev exited before it was ready");
    const health = await httpGet(mockPort, "/v1/health").catch(() => null);
    const ui = await httpGet(uiPort, "/").catch(() => null);
    if (health?.status === 200 && ui?.status === 200 && ui.body.includes("kiosk")) return;
    await delay(500);
  }
  throw new Error("mock-dev did not become usable within 90 s");
}

async function launch() {
  mkdirSync(runDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });
  for (const port of [mockPort, uiPort]) {
    const owners = portPids(port);
    if (owners.length) {
      throw new Error(`127.0.0.1:${port} is already owned by pid ${owners.join(",")}; refusing to share it`);
    }
  }
  const logFd = openSync(logFile, "a");
  const child = spawn(
    "bash",
    // Agent machines put vp on PATH through this env file; CI already has it on PATH.
    ["-c", 'env="$HOME/.config/vite-plus/env"; if [ -f "$env" ]; then . "$env"; fi; exec vp run mock-dev'],
    { cwd: kiosk, detached: true, stdio: ["ignore", logFd, logFd] },
  );
  child.unref();
  writeFileSync(pidFile, `${child.pid}\n`);
  console.log(`launched pid ${child.pid}; log ${logFile}`);
  try {
    await waitReady(child.pid);
  } catch (error) {
    const log = readFileSync(logFile, "utf8").split("\n").slice(-40).join("\n");
    console.error(`--- last lines of ${logFile}\n${log}`);
    cleanup();
    throw error;
  }
  console.log(`ready http://127.0.0.1:${uiPort}/ mock http://127.0.0.1:${mockPort}/v1/health`);
}

function cleanup() {
  if (!existsSync(pidFile)) {
    console.log("no recorded pid; nothing to stop");
    return;
  }
  const pid = readPid();
  try {
    process.kill(-pid, "SIGTERM");
    console.log(`sent SIGTERM to process group ${pid}`);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    console.log(`process group ${pid} was already gone`);
  }
  rmSync(runDir, { recursive: true, force: true });
  console.log(`removed ${runDir}; evidence remains at ${evidenceDir}`);
}

async function doctor() {
  const pid = readPid();
  if (!existsSync(`/proc/${pid}`)) throw new Error(`recorded pid ${pid} is not running`);
  for (const port of [mockPort, uiPort]) {
    const owners = portPids(port);
    if (!owners.includes(pid) && !owners.some((owner) => parentIs(owner, pid))) {
      throw new Error(`port ${port} owners ${owners.join(",") || "none"} are not children of ${pid}`);
    }
  }
  const health = await httpGet(mockPort, "/v1/health");
  if (health.status !== 200) throw new Error(`mock health status ${health.status}`);
  const body = JSON.parse(health.body);
  const ui = await httpGet(uiPort, "/");
  if (ui.status !== 200 || !ui.body.includes("kiosk")) throw new Error("kiosk UI is not serving the app shell");
  console.log(
    JSON.stringify({
      pid,
      ui: `http://127.0.0.1:${uiPort}/`,
      mock: `http://127.0.0.1:${mockPort}`,
      apiVersion: body.version ?? null,
    }),
  );
}

function parentIs(pid, ancestor) {
  let current = pid;
  for (let i = 0; i < 8; i += 1) {
    try {
      const stat = readFileSync(`/proc/${current}/stat`, "utf8");
      const ppid = Number(stat.split(")")[1]?.trim().split(/\s+/)[1]);
      if (ppid === ancestor) return true;
      if (!ppid || ppid === 1) return false;
      current = ppid;
    } catch {
      return false;
    }
  }
  return false;
}

async function driveTheme() {
  const { chromium } = createRequire(import.meta.url)(`${kiosk}/node_modules/@playwright/test`);
  mkdirSync(`${evidenceDir}/theme`, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`http://127.0.0.1:${uiPort}/`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { level: 1, name: "factory", exact: true }).waitFor();
    await page.getByRole("status", { name: "Live" }).waitFor({ timeout: 20_000 }).catch(async () => {
      await page.getByText("Live", { exact: true }).waitFor({ timeout: 20_000 });
    });
    const button = page.getByRole("button", { name: /Use (dark|light) theme/ });
    const before = await button.getAttribute("aria-label");
    if (before !== "Use dark theme" && before !== "Use light theme") {
      throw new Error(`unexpected theme button label ${before}`);
    }
    const beforeTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? "");
    await button.click();
    const after = before === "Use dark theme" ? "Use light theme" : "Use dark theme";
    await page.getByRole("button", { name: after }).waitFor();
    const afterTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? "");
    const stored = await page.evaluate(() => localStorage.getItem("factory-theme"));
    if (afterTheme === beforeTheme) throw new Error("theme did not change on <html>");
    if (stored !== afterTheme) throw new Error(`localStorage factory-theme=${stored}, html theme=${afterTheme}`);
    const shot = `${evidenceDir}/theme/after.png`;
    const aria = `${evidenceDir}/theme/after.aria.txt`;
    await page.screenshot({ path: shot, fullPage: true });
    writeFileSync(
      aria,
      [
        `before-label: ${before}`,
        `after-label: ${after}`,
        `before-theme: ${beforeTheme}`,
        `after-theme: ${afterTheme}`,
        `localStorage factory-theme: ${stored}`,
        `heading: factory`,
      ].join("\n") + "\n",
    );
    console.log(`proved theme ${beforeTheme} -> ${afterTheme}; evidence ${shot} ${aria}`);
  } finally {
    await browser.close();
  }
}

// Opens a fresh context on `path`, records every request the browser sends, and waits for the h1.
async function openPage(path) {
  const { chromium } = createRequire(import.meta.url)(`${kiosk}/node_modules/@playwright/test`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const requests = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    requests.push(`${r.method()} ${url.pathname}${url.search}`);
  });
  await page.goto(`http://127.0.0.1:${uiPort}${path}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: "factory", exact: true }).waitFor();
  return { browser, page, requests };
}

async function waitForRequest(requests, wanted, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!requests.includes(wanted)) {
    if (Date.now() > deadline) throw new Error(`browser never sent ${wanted}`);
    await delay(200);
  }
}

// Shared by the usage and GPU range journeys: default range, then click each other range.
async function driveRange({ feature, entry, group, endpoint, ranges, ready }) {
  const dir = `${evidenceDir}/${feature}`;
  mkdirSync(dir, { recursive: true });
  const { browser, page, requests } = await openPage("/");
  try {
    await waitForRequest(requests, `GET ${endpoint}?range=${ranges[0]}`);
    await entry(page);
    const control = page.getByRole("group", { name: group, exact: true });
    await control.waitFor();
    await ready(page);
    const lines = [`feature: ${feature}`, `url: ${page.url()}`];
    for (const [i, range] of ranges.entries()) {
      const button = control.getByRole("button", { name: range, exact: true });
      if (i > 0) {
        await button.click();
        await waitForRequest(requests, `GET ${endpoint}?range=${range}`);
      }
      const pressed = await button.getAttribute("aria-pressed");
      if (pressed !== "true") throw new Error(`${range} is not pressed after choosing it`);
      lines.push(`${range}: pressed, GET ${endpoint}?range=${range}`);
    }
    // Cards fade in as they scroll into view, so a full-page capture shows them blank.
    await control.scrollIntoViewIfNeeded();
    await delay(1000);
    await page.screenshot({ path: `${dir}/after.png` });
    writeFileSync(`${dir}/requests.txt`, lines.join("\n") + "\n");
    console.log(`proved ${feature} ${ranges.join(" -> ")}; evidence ${dir}`);
  } finally {
    await browser.close();
  }
}

const driveUsage = () =>
  driveRange({
    feature: "usage-range",
    entry: async (page) => {
      await page.getByRole("link", { name: "Local LLM usage, pricing and model details" }).click();
      await page.waitForURL("**/llm");
    },
    group: "Usage range",
    endpoint: "/v1/llm/usage",
    ranges: ["24h", "7d", "30d"],
    ready: (page) => page.getByRole("heading", { name: "Local LLM · Usage & spend" }).waitFor(),
  });

const driveGpu = () =>
  driveRange({
    feature: "gpu-range",
    entry: async () => {},
    group: "GPU history range",
    endpoint: "/v1/gpu",
    ranges: ["1h", "24h", "7d"],
    ready: (page) =>
      page.getByRole("region", { name: "GPU", exact: true }).getByText("Utilization").first().waitFor(),
  });

async function driveFrontier() {
  const dir = `${evidenceDir}/frontier-refresh`;
  mkdirSync(dir, { recursive: true });
  const { browser, page } = await openPage("/");
  try {
    const card = page.getByRole("region", { name: "Frontier CLIs" });
    const rows = ["Amp", "Cursor", "Claude Code", "ChatGPT", "Kimi", "OpenCode"];
    for (const row of rows) await card.getByRole("listitem", { name: row, exact: true }).waitFor();
    const button = card.getByRole("button", { name: "Refresh usage" });
    // The cooldown ends 3 minutes after the newest observation; wait it out like a user would.
    const cooldownStart = Date.now();
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="Refresh usage"]')?.disabled,
      null,
      { timeout: 200_000, polling: 1000 },
    );
    const waited = Math.round((Date.now() - cooldownStart) / 1000);
    const post = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/v1/agents/refresh"),
    );
    await button.click();
    const response = await post;
    if (response.status() !== 202) throw new Error(`POST /v1/agents/refresh answered ${response.status()}`);
    await card.getByText("Refreshing…").waitFor({ timeout: 5000 });
    const disabled = await button.isDisabled();
    if (!disabled) throw new Error("refresh button stayed enabled while refreshing");
    const updated = card.getByText(/^Updated (just now|\d+ min ago)/);
    await updated.waitFor({ timeout: 90_000 });
    if (await card.getByText("Refreshing…").count()) throw new Error("Refreshing… did not clear");
    for (const row of rows) await card.getByRole("listitem", { name: row, exact: true }).waitFor();
    const status = (await updated.innerText()).split("\n")[0].trim();
    await card.scrollIntoViewIfNeeded();
    await delay(1000);
    await card.screenshot({ path: `${dir}/after.png` });
    writeFileSync(
      `${dir}/result.txt`,
      [
        `feature: frontier-refresh`,
        `cooldown waited: ${waited} s`,
        `POST /v1/agents/refresh: ${response.status()}`,
        `while waiting: Refreshing…, button disabled`,
        `after agents.usage: ${status}`,
        `rows: ${rows.join(", ")}`,
      ].join("\n") + "\n",
    );
    console.log(`proved frontier refresh (202, then "${status}"); evidence ${dir}`);
  } finally {
    await browser.close();
  }
}

const journeys = { theme: () => driveTheme(), usage: driveUsage, gpu: driveGpu, frontier: driveFrontier };

try {
  if (command === "launch") await launch();
  else if (command === "doctor") await doctor();
  else if (command === "drive" && process.argv[3] === "all")
    for (const drive of Object.values(journeys)) await drive();
  else if (command === "drive" && process.argv[3] in journeys) await journeys[process.argv[3]]();
  else if (command === "cleanup") cleanup();
  else {
    console.error(`usage: verify.mjs launch|doctor|drive ${Object.keys(journeys).join("|")}|all|cleanup`);
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
