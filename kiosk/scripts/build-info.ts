import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export function buildInfo() {
  const root = new URL("../../", import.meta.url);
  const version = readFileSync(new URL("VERSION", root), "utf8").trim();
  const manifest = JSON.parse(readFileSync(new URL("kiosk/package.json", root), "utf8")) as {
    version: string;
  };
  if (manifest.version !== version) throw new Error("kiosk version must match VERSION");
  const release = process.env.FACTORY_RELEASE_VERSION;
  if (release !== undefined) {
    const parse = (text: string) => {
      if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(text)) {
        throw new Error("release version must be stable SemVer");
      }
      const parts = text.split(".").map(Number);
      if (parts.some((part) => part > 4294967295)) {
        throw new Error("release version component exceeds u32");
      }
      return parts;
    };
    const floor = parse(version);
    const parts = parse(release);
    const different = parts.findIndex((part, index) => part !== floor[index]);
    if (different !== -1 && parts[different]! < floor[different]!) {
      throw new Error("release version below VERSION");
    }
  }
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
  const releaseSha = release === undefined ? undefined : git(["rev-parse", "HEAD"]);
  const releaseTime =
    release === undefined ? undefined : git(["show", "-s", "--format=%ct", "HEAD"]);
  if (release !== undefined && (!releaseSha || !releaseTime)) {
    throw new Error("release build requires git identity and commit time");
  }
  return {
    version: release ?? version,
    git_sha: releaseSha ?? git(["rev-parse", "--short=7", "HEAD"]) ?? "unknown",
    git_dirty: Boolean(git(["status", "--porcelain"])),
    built_at_ms: releaseTime === undefined ? Date.now() : Number(releaseTime) * 1000,
    inputs_fingerprint: fingerprint("kiosk"),
    expected_inputs: {
      api: fingerprint("factory-api"),
      meter: fingerprint("meter"),
    },
  };
}
