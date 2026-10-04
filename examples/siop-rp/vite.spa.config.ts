import { resolve } from "node:path";
import { defineConfig } from "vite";

const repoRoot = resolve(import.meta.dirname, "../..");

/**
 * The single-page relying party (`src/spa`). Its two settings are baked in:
 *
 *   OPENSESAME_PAGES_BASE   https://<owner>.github.io/<repo>
 *   SIOP_RP_CLIENT_ID       local_<uuid>, as the person registered it
 *
 * The redirect URI is the page's own address, so register
 * `http://127.0.0.1:4111/` (dev) or wherever you host the build.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, "src/spa"),
  define: {
    __SIOP_SPA_CONFIG__: JSON.stringify({
      pagesBase: (
        process.env.OPENSESAME_PAGES_BASE ??
        "https://tyler-r-kendrick.github.io/OpenSesame"
      ).replace(/\/+$/u, ""),
      clientId:
        process.env.SIOP_RP_CLIENT_ID ??
        "local_00000000-0000-4000-8000-000000000001",
    }),
  },
  build: {
    target: ["es2022", "chrome100", "firefox100", "safari15"],
    outDir: resolve(import.meta.dirname, "dist/spa"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 4111,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
  resolve: {
    alias: {
      // The browser build of the domain package: no Node-only code.
      "@opensesame/os-domain": resolve(
        repoRoot,
        "packages/os-domain/src/browser.ts",
      ),
    },
  },
});
