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
import { setTimeout as delay } from "node:timers/promises";

const repo = "/home/agent/work/factory";
const kiosk = `${repo}/kiosk`;
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

async function waitReady() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    const mockReady = log.includes(`Mock API on 127.0.0.1:${mockPort}`);
    const uiReady = log.includes(`http://127.0.0.1:${uiPort}/`);
    if (mockReady && uiReady) {
      const health = await httpGet(mockPort, "/v1/health").catch(() => null);
      const ui = await httpGet(uiPort, "/").catch(() => null);
      if (health?.status === 200 && ui?.status === 200 && ui.body.includes("kiosk")) return;
    }
    await delay(500);
  }
  throw new Error(`mock-dev did not become usable; see ${logFile}`);
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
    [
      "-lc",
      "source /home/agent/.config/vite-plus/env && cd /home/agent/work/factory/kiosk && exec vp run mock-dev",
    ],
    { detached: true, stdio: ["ignore", logFd, logFd] },
  );
  child.unref();
  writeFileSync(pidFile, `${child.pid}\n`);
  console.log(`launched pid ${child.pid}; log ${logFile}`);
  try {
    await waitReady();
  } catch (error) {
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
  process.env.PLAYWRIGHT_BROWSERS_PATH = `${kiosk}/.browsers`;
  const { chromium } = createRequire(import.meta.url)(`${kiosk}/node_modules/@playwright/test`);
  mkdirSync(`${evidenceDir}/theme`, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`http://127.0.0.1:${uiPort}/`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { level: 1, name: "factory / kiosk" }).waitFor();
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
        `heading: factory / kiosk`,
      ].join("\n") + "\n",
    );
    console.log(`proved theme ${beforeTheme} -> ${afterTheme}; evidence ${shot} ${aria}`);
  } finally {
    await browser.close();
  }
}

try {
  if (command === "launch") await launch();
  else if (command === "doctor") await doctor();
  else if (command === "drive" && process.argv[3] === "theme") await driveTheme();
  else if (command === "cleanup") cleanup();
  else {
    console.error("usage: verify.mjs launch|doctor|drive theme|cleanup");
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
