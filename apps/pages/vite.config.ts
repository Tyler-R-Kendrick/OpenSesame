import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const base = process.env.VITE_BASE ?? "/OpenSesame/";
const osDomainBrowser = fileURLToPath(
  new URL("../../packages/os-domain/src/browser.ts", import.meta.url),
);

export default defineConfig({
  base,
  define: { "process.env.NODE_DEBUG_NATIVE": "false" },
  resolve: {
    alias: {
      "@opensesame/os-domain": osDomainBrowser,
    },
  },
  optimizeDeps: {
    exclude: ["@opensesame/os-domain"],
    esbuildOptions: { target: "es2022" },
  },
  server: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  build: {
    // esbuild 0.28 cannot downlevel some destructuring forms used by react-router
    // to Vite's default legacy browser set; GitHub Pages clients are modern.
    target: ["es2022", "chrome100", "firefox100", "safari15"],
  },
  // Dependency pre-bundling in dev has its own target and hits the same limitation.
  esbuild: { target: "es2022" },
  plugins: [
    {
      // The Identity API's auto-admitted origin client returns brokered legs
      // to `<origin>/opensesame/callback` (ADR 0050's canonical path), which
      // sits OUTSIDE this app's base. In production GitHub Pages serves it via
      // the 404 SPA fallback; the dev server has no such fallback outside the
      // base, so bounce it onto the base with the auth response intact — the
      // app routes on `?code`, never on the path.
      name: "origin-profile-canonical-callback",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith("/opensesame/callback")) {
            const query = req.url.slice("/opensesame/callback".length);
            res.statusCode = 302;
            res.setHeader(
              "location",
              `${base}${query.startsWith("?") ? query : ""}`,
            );
            res.end();
            return;
          }
          next();
        });
      },
    },
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectRegister: false,
      includeAssets: ["icon.svg", "auth.js"],
      manifest: {
        name: "OpenSesame",
        short_name: "OpenSesame",
        description:
          "End-to-end-encrypted vault for passwords, passkeys, and agent secrets",
        theme_color: "#fafafa",
        background_color: "#fafafa",
        display: "standalone",
        start_url: "./",
        scope: "./",
        icons: [
          {
            src: "icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,wasm,css,html,svg,ico,webp,woff2}"],
        maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
      },
      devOptions: { enabled: true, navigateFallback: "index.html" },
    }),
    {
      // Dev-only: Vite injects inline module scripts that CSP would block.
      name: "csp-inline-script-hashes",
      transformIndexHtml: {
        order: "post",
        handler(html) {
          const hashes = [
            ...html.matchAll(
              /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi,
            ),
          ].map(
            (match) =>
              `'sha256-${createHash("sha256")
                .update(match[1] ?? "")
                .digest("base64")}'`,
          );
          if (hashes.length === 0) return html;
          return html.replace(
            "script-src 'self' 'wasm-unsafe-eval'",
            `script-src 'self' 'wasm-unsafe-eval' ${hashes.join(" ")}`,
          );
        },
      },
    },
  ],
});
