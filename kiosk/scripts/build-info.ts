import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export function buildInfo() {
  const root = new URL("../../", import.meta.url);
  const version = readFileSync(new URL("VERSION", root), "utf8").trim();
  const manifest = JSON.parse(readFileSync(new URL("kiosk/package.json", root), "utf8")) as {
    version: string;
  };
  if (manifest.version !== version) throw new Error("kiosk version must match VERSION");
  const git = (args: string[]) => {
    if (!existsSync(new URL(".git", root))) return undefined;
    try {
      return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
    } catch {
      return undefined;
    }
  };
  const fingerprint = (component: string) =>
    execFileSync("bash", [new URL("scripts/build-fingerprint.sh", root).pathname, component], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  return {
    version,
    git_sha: git(["rev-parse", "--short=7", "HEAD"]) ?? "unknown",
    git_dirty: Boolean(git(["status", "--porcelain"])),
    built_at_ms: Date.now(),
    inputs_fingerprint: fingerprint("kiosk"),
    expected_inputs: {
      api: fingerprint("factory-api"),
      meter: fingerprint("meter"),
    },
  };
}
