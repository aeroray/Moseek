import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * The app version, read from `package.json` and injected as a literal.
 *
 * The settings page displays it, and the updater compares the running version against the manifest
 * to decide whether an update exists. Reading one source means the number on screen cannot disagree
 * with the number the comparison used — a hard-coded copy would eventually do exactly that.
 */
const packageJson = JSON.parse(
  readFileSync(path.resolve(rootDirectory, "./package.json"), "utf8"),
) as { version: string };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDirectory, "./src"),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    /**
     * Raised above the 500 kB default because of one unavoidable chunk.
     *
     * Splitting the media libraries out leaves `vendor-hls` as the only chunk over 500 kB, and
     * that is hls.js's own size — the light build would drop HEVC and AC-3, which IPTV streams
     * in this app actually use, so it is not an option. The threshold is set just above it so a
     * *new* oversized chunk still gets reported: the warning is useful, it just should not fire
     * on a dependency we have deliberately chosen and cannot shrink.
     */
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        /**
         * Keep the two large media libraries in their own chunks.
         *
         * hls.js and Plyr are ~700 kB together and were being folded into whichever feature
         * chunk happened to share them — the diagnostic panel, of all things, because the live
         * view and the player view both import the player and the panel. That produced a single
         * chunk over the warning threshold, and it meant opening 播放诊断 loaded the whole
         * player. Splitting them out keeps each feature chunk small and lets the browser cache
         * the libraries separately from app code that changes far more often. The panel chunk
         * went from 730 kB to 24 kB.
         */
        manualChunks: {
          "vendor-hls": ["hls.js"],
          "vendor-plyr": ["plyr"],
        },
      },
    },
  },
});
