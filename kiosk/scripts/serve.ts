import { spawn } from "node:child_process";

const preview = process.argv.includes("--preview");
const mock = spawn(process.execPath, ["mock/server.ts"], { stdio: "inherit" });
const ui = spawn(
  "vp",
  [
    preview ? "preview" : "dev",
    "--host",
    "127.0.0.1",
    "--port",
    preview ? "4180" : "4181",
    "--strictPort",
  ],
  { stdio: "inherit", env: { ...process.env, KIOSK_MOCK: "1" } },
);
function stop() {
  mock.kill();
  ui.kill();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of [mock, ui])
  child.on("exit", (code) => {
    stop();
    process.exitCode ??= code ?? 0;
  });
