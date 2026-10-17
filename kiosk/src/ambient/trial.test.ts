// @vitest-environment node
/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

const script = fileURLToPath(new URL("../../scripts/ambient-trial.sh", import.meta.url));
const kioskFlags = [
  "--kiosk",
  "--app=https://factory-gpu.bearded-pompano.ts.net",
  "--noerrdialogs",
  "--password-store=basic",
];

describe("ambient-trial.sh --dry-run", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  const process_ = (pid: number, uid: number, argv: string[], environ: string[] = []) => {
    const dir = join(root, "proc", String(pid));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status"), `Name:\tchrome\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    writeFileSync(join(dir, "cmdline"), `${argv.join("\0")}\0`);
    writeFileSync(join(dir, "environ"), `${environ.join("\0")}\0`);
  };
  const tool = (name: string, body: string) => {
    const file = join(root, "bin", name);
    writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(file, 0o755);
  };
  const run = (...args: string[]) =>
    spawnSync("bash", [script, ...args], { env, encoding: "utf8" });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ambient-trial-test."));
    mkdirSync(join(root, "bin"));
    // The kiosk browser process, one of its renderers, and another user's kiosk Chrome.
    process_(
      2953,
      1001,
      ["/opt/google/chrome/chrome", ...kioskFlags],
      [
        "WAYLAND_DISPLAY=wayland-0",
        "DISPLAY=:0",
        "XDG_RUNTIME_DIR=/run/user/1001",
        "KIOSK_SECRET=do-not-copy",
      ],
    );
    process_(3001, 1001, ["/opt/google/chrome/chrome", "--type=renderer", "--kiosk"]);
    process_(4000, 1000, ["/opt/google/chrome/chrome", "--kiosk"]);
    writeFileSync(
      join(root, "console-kiosk.desktop"),
      `[Desktop Entry]\nType=Application\nExec=/usr/bin/google-chrome ${kioskFlags.join(" ")} %U\n`,
    );
    tool("id", '[[ $* == "-u console" ]] && echo 1001 || echo 0');
    tool("hostname", "echo ${FAKE_HOST:-factory-console}");
    tool("runuser", `echo "runuser $*" >> "${root}/runuser.log"`);
    env = {
      PATH: `${join(root, "bin")}:/usr/bin:/bin`,
      AMBIENT_TRIAL_PROC: join(root, "proc"),
      AMBIENT_TRIAL_AUTOSTART: join(root, "console-kiosk.desktop"),
      AMBIENT_TRIAL_LOCK: join(root, "trial.lock"),
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("passes preflight and prints the trial Chrome without launching it", () => {
    const result = run("--dry-run", "both");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("kiosk pid 2953");
    const planned = result.stdout.split("planned:")[1]!;
    expect(planned).toContain("runuser -u console -- env -i HOME=/home/console");
    expect(planned).toContain(
      "WAYLAND_DISPLAY=wayland-0 DISPLAY=:0 XDG_RUNTIME_DIR=/run/user/1001 /usr/bin/google-chrome --kiosk",
    );
    expect(planned).toContain(
      "--app=https://factory-gpu.bearded-pompano.ts.net/\\?ambient=both\\&perf=1 --noerrdialogs",
    );
    expect(planned).toContain(
      "--remote-debugging-port=0 --remote-debugging-address=127.0.0.1 --start-fullscreen",
    );
    expect(planned).not.toContain("KIOSK_SECRET");
    expect(planned).not.toContain("%U");
    expect(planned).not.toContain("--app=https://factory-gpu.bearded-pompano.ts.net ");
    // Only the agent Node check ran; nothing was started as console.
    const calls = readFileSync(join(root, "runuser.log"), "utf8").trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^runuser -u agent -- env -i HOME=\/home\/agent /);
  });

  it("loads the unchanged kiosk for the v1 baseline", () => {
    const result = run("v1", "3", "--dry-run");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("mode v1, 3 min");
    expect(result.stdout).toContain("--app=https://factory-gpu.bearded-pompano.ts.net/\\?perf=1 ");
  });

  it("refuses the wrong host, a missing kiosk, a held lock and bad arguments", () => {
    env.FAKE_HOST = "factory-gpu";
    expect(run("--dry-run", "both")).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("not factory-console"),
    });
    delete env.FAKE_HOST;

    const held = spawnSync(
      "flock",
      [join(root, "trial.lock"), "bash", script, "--dry-run", "both"],
      {
        env,
        encoding: "utf8",
      },
    );
    expect(held).toMatchObject({ status: 1, stderr: expect.stringContaining("already running") });

    rmSync(join(root, "proc", "2953"), { recursive: true });
    expect(run("--dry-run", "both")).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("not running as console"),
    });

    expect(run("--dry-run", "stars").status).toBe(2);
    expect(run("--dry-run", "both", "0").status).toBe(1);
  });

  it("refuses to run as a regular user", () => {
    tool("id", '[[ $* == "-u console" ]] && echo 1001 || echo 1002');
    expect(run("--dry-run", "both")).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("run as root"),
    });
  });
});
