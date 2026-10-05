import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * The same version literal `vite.config.ts` injects.
 *
 * Tests do not go through Vite's `define`, so without this the settings page throws
 * `__APP_VERSION__ is not defined`. Reading it from `package.json` here rather than hard-coding a
 * value keeps the tests asserting against the version that will actually ship.
 */
const packageJson = JSON.parse(
  readFileSync(path.resolve(rootDirectory, "./package.json"), "utf8"),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDirectory, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
