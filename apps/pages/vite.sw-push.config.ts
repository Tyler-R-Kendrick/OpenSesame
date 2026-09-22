/**
 * Build config for the push-capable service worker, `dist/sw-push.js`.
 *
 * Driven by `scripts/build-workers.mjs`, which loads this file, adds the
 * `self.__WB_MANIFEST` define (the shell entry and its md5, the same values
 * vite-plugin-pwa injects into `sw.js`) and runs the build into the main
 * `dist/` without emptying it. One input, one ES output with dynamic imports
 * inlined: a service worker cannot `import()` at runtime, so the emitted file
 * must be self-contained.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const base = process.env.VITE_BASE ?? "/OpenSesame/";
const osDomainBrowser = fileURLToPath(
  new URL("../../packages/os-domain/src/browser.ts", import.meta.url),
);

export default defineConfig({
  base,
  publicDir: false,
  resolve: {
    alias: { "@opensesame/os-domain": osDomainBrowser },
  },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  esbuild: { target: "es2022" },
  build: {
    target: ["es2022", "chrome100", "firefox100", "safari15"],
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: false,
    copyPublicDir: false,
    modulePreload: false,
    sourcemap: false,
    rollupOptions: {
      input: fileURLToPath(new URL("./src/sw-push.ts", import.meta.url)),
      output: {
        format: "es",
        entryFileNames: "sw-push.js",
        inlineDynamicImports: true,
      },
    },
  },
});
