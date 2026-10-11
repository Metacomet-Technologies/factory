import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { defineConfig, lazyPlugins } from "vite-plus";
import { apiTypes } from "./scripts/api-types.ts";

// Keep the normal check gate tied to the deployed contract, not just a stale snapshot.
if (process.argv.includes("check")) await apiTypes(true);

const proxyTarget =
  process.env.KIOSK_API_PROXY ??
  (process.env.KIOSK_MOCK ? `http://127.0.0.1:${process.env.MOCK_PORT ?? 4179}` : undefined);
const proxy = proxyTarget
  ? Object.fromEntries(["/v1", "/openapi.json"].map((path) => [path, { target: proxyTarget }]))
  : {};

// https://vite.dev/config/
export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
  run: {
    tasks: {
      "mock-dev": { command: "node scripts/serve.ts", cache: false },
      "mock-preview": { command: "node scripts/serve.ts --preview", cache: false },
      "mock-outage": { command: "MOCK_PORT=4182 MOCK_OUTAGE=1 node mock/server.ts", cache: false },
      screenshots: { command: "node scripts/screenshots.ts", cache: false },
      "api:types": { command: "node scripts/api-types.ts", cache: false },
      "api:types:check": { command: "node scripts/api-types.ts --check", cache: false },
      "screenshots:live": { command: "node scripts/live-check.ts", cache: false },
    },
  },
  server: {
    proxy,
  },
  preview: {
    proxy,
  },
  fmt: {},
  lint: {
    plugins: ["react", "typescript", "oxc"],
    rules: {
      "react/rules-of-hooks": "error",
      "react/only-export-components": [
        "warn",
        {
          allowConstantExport: true,
          allowExportNames: [
            "buttonVariants",
            "badgeVariants",
            "toggleVariants",
            "tabsListVariants",
          ],
        },
      ],
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [
    ...(lazyPlugins(() => [react(), tailwindcss()]) ?? []),
    {
      name: "kiosk-build-identity",
      apply: "build",
      generateBundle: {
        order: "post",
        handler(_, bundle) {
          const hash = createHash("sha256");
          for (const name of Object.keys(bundle).sort()) {
            const file = bundle[name]!;
            hash.update(name);
            hash.update(file.type === "chunk" ? file.code : file.source);
          }
          const build = hash.digest("hex");
          const index = bundle["index.html"];
          if (!index || index.type !== "asset") throw new Error("Missing kiosk index.html");
          index.source = String(index.source).replace(
            "</head>",
            `<meta name="kiosk-build" content="${build}" /></head>`,
          );
          this.emitFile({
            type: "asset",
            fileName: "version.json",
            source: JSON.stringify({ build }),
          });
        },
      },
    },
  ],
});
