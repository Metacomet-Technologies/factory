import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig, lazyPlugins } from "vite-plus";

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
    },
  },
  server: {
    proxy: process.env.KIOSK_MOCK
      ? {
          "/v1": {
            target: `http://127.0.0.1:${process.env.MOCK_PORT ?? 4179}`,
            changeOrigin: true,
          },
        }
      : {},
  },
  preview: {
    proxy: process.env.KIOSK_MOCK
      ? {
          "/v1": {
            target: `http://127.0.0.1:${process.env.MOCK_PORT ?? 4179}`,
            changeOrigin: true,
          },
        }
      : {},
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
  plugins: lazyPlugins(() => [react(), tailwindcss()]) ?? [],
});
