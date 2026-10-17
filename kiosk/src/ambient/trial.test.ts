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

describe("ambient-trial.sh CPU accounting", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ambient-cpu-test."));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  // /proc/<pid>/stat with utime (field 14), cutime (16) and starttime (22); the rest zero.
  const stage = (
    name: string,
    rows: [pid: number, ppid: number, own: number, reaped: number][],
  ) => {
    for (const [pid, ppid, own, reaped] of rows) {
      const dir = join(root, name, String(pid));
      mkdirSync(dir, { recursive: true });
      const fields = [ppid, ...Array<number>(9).fill(0), own, 0, reaped, 0, 0, 0, 0, 0, pid * 7, 0];
      writeFileSync(join(dir, "stat"), `${pid} (Chrome Helper (Renderer)) S ${fields.join(" ")}\n`);
    }
  };
  const bash = (body: string) => {
    const result = spawnSync("bash", ["-c", `set -euo pipefail; source "$0"; ${body}`, script], {
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    return result.stdout.trim().split(/\s+/).map(Number);
  };
  const sample = (name: string) =>
    `proc=${join(root, name)}; read_stats; tree_delta 100 trial; t=$delta; tree_delta 300 kiosk; echo $t $delta;`;

  it("counts a sampled child once after its parent reaps it", () => {
    // Trial parent 100 with child 101, an unrelated process 200, and the kiosk root 300.
    stage("base", [
      [100, 1, 10, 0],
      [101, 100, 100, 0],
      [200, 1, 50, 0],
      [300, 1, 40, 0],
    ]);
    // 101 exited and was reaped: parent own 30, reaped 100. 200 and the kiosk kept running.
    stage("reaped", [
      [100, 1, 30, 100],
      [200, 1, 500, 0],
      [300, 1, 45, 0],
    ]);
    expect(bash(sample("base") + sample("reaped"))).toEqual([110, 40, 20, 5]);
  });

  it("keeps steady and re-parented members and ignores unrelated processes", () => {
    stage("base", [
      [100, 1, 10, 0],
      [101, 100, 100, 0],
      [200, 1, 50, 0],
      [300, 1, 40, 0],
    ]);
    // 101 was re-parented to init and kept running; 200 is not part of either tree.
    stage("steady", [
      [100, 1, 15, 0],
      [101, 1, 110, 0],
      [200, 1, 500, 0],
      [300, 1, 40, 0],
    ]);
    expect(bash(sample("base") + sample("steady"))).toEqual([110, 40, 15, 0]);
  });

  it("counts a real short-lived child chain exactly once", () => {
    // root -> timeout -> busy bash: sampled mid-run, then reaped before the next sample.
    const [mid, after, growth] = bash(`
      ( sleep 0.4; timeout 0.8 bash -c 'while :; do :; done' || :; exec sleep 5 ) &
      r=$!
      sleep 0.2; read_stats; tree_delta "$r" trial; base=$((own[$r] + reaped[$r]))
      sleep 0.6; read_stats; tree_delta "$r" trial; mid=$delta
      sleep 1.2; read_stats; tree_delta "$r" trial; after=$delta
      kill "$r"
      echo "$mid" "$after" "$((own[$r] + reaped[$r] - base))"`);
    expect(mid).toBeGreaterThanOrEqual(5);
    // Everything ended up in the root's own and reaped CPU; only the baseline sleep's
    // tick, if any, was already counted before.
    expect(mid! + after!).toBeLessThanOrEqual(growth!);
    expect(mid! + after!).toBeGreaterThanOrEqual(growth! - 1);
  });
});
