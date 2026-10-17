import { defineConfig, build, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * The live-site overlay ships as its own standalone ES module
 * (dist/live-overlay.js, no framework, CSS inlined into its Shadow DOM), so it
 * is built in a second pass right after the app. One `vite build` makes both.
 */
function liveOverlay(): Plugin {
  return {
    name: "tq-live-overlay",
    apply: "build",
    async closeBundle() {
      await build({
        configFile: false,
        root,
        logLevel: "warn",
        publicDir: false,
        build: {
          outDir: "dist",
          emptyOutDir: false,
          target: "es2020",
          minify: true,
          // Not lib mode: lib "es" output keeps whitespace; this way it is fully minified.
          rollupOptions: {
            input: `${root}src/live/overlay.ts`,
            output: { format: "es", entryFileNames: "live-overlay.js", codeSplitting: false },
          },
        },
      });
    },
  };
}

export default defineConfig({
  base: "/",
  plugins: [svelte(), liveOverlay()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    cssCodeSplit: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/live/": "http://localhost:8080",
      "/media": "http://localhost:8080",
      "/mcp": "http://localhost:8080",
    },
  },
});
