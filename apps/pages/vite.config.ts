import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { configDefaults } from "vitest/config";
import { crossOriginOpenerPolicy } from "../../packages/app-core/src/lib/opener-policy.ts";
import { capabilityCompose } from "./scripts/capability-compose-plugin.mjs";
import { githubAppRelayPlugin } from "./scripts/github-app-relay-plugin.mjs";
import { impeccableDevHtml } from "./scripts/impeccable-dev.mjs";
import { siopMetadata } from "./scripts/siop-metadata-plugin.mjs";

const base = process.env.VITE_BASE ?? "/OpenSesame/";
/**
 * The entry chunk's ceiling, in Vite's kB: a hardened profile's
 * `largestAsset` in `tools/quality/bundle-budgets.json` is that chunk, and
 * the bundle gate enforces it, so Vite warns at the same line instead of at
 * its generic 500 kB.
 */
const entryChunkWarningKb = Math.ceil(
  JSON.parse(
    readFileSync(
      new URL("../../tools/quality/bundle-budgets.json", import.meta.url),
      "utf8",
    ),
  ).profiles.builds["minimal-local-hardened"].budgets.largestAsset * 1.024,
);
const osDomainBrowser = fileURLToPath(
  new URL("../../packages/os-domain/src/browser.ts", import.meta.url),
);
const osDomainAuthorityTemplates = fileURLToPath(
  new URL(
    "../../packages/os-domain/src/authority-templates/index.ts",
    import.meta.url,
  ),
);
const osDomainWallet = fileURLToPath(
  new URL("../../packages/os-domain/src/wallet/index.ts", import.meta.url),
);

function redirectBareBase(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  pathOnly: string,
  base: string,
): boolean {
  const bareBase = base.endsWith("/") ? base.slice(0, -1) : base;
  if (!bareBase || pathOnly !== bareBase) return false;
  const qs = req.url?.includes("?")
    ? `?${req.url.split("?").slice(1).join("?")}`
    : "";
  res.statusCode = 302;
  res.setHeader("Location", `${base}${qs}`);
  res.end();
  return true;
}

function handleAgentPage(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  pathOnly: string,
  base: string,
): boolean {
  if (pathOnly !== `${base}__agent_page` && pathOnly !== "/__agent_page") {
    return false;
  }
  if (req.method === "POST") {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      try {
        writeFileSync(
          "/tmp/agent-page.json",
          Buffer.concat(chunks).toString("utf8"),
        );
      } catch {
        /* ignore write failures in the agent probe path */
      }
      res.statusCode = 204;
      res.end();
    });
    return true;
  }
  res.statusCode = 204;
  res.end();
  return true;
}

function handlePagesDevRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  next: () => void,
  base: string,
): void {
  const coop = crossOriginOpenerPolicy(req.url?.split("?")[0] ?? "", base);
  if (coop) res.setHeader("Cross-Origin-Opener-Policy", coop);
  const pathOnly = req.url?.split("?")[0] ?? "";
  if (redirectBareBase(req, res, pathOnly, base)) return;
  if (handleAgentPage(req, res, pathOnly, base)) return;
  if (req.url?.startsWith("/opensesame/callback")) {
    const query = req.url.slice("/opensesame/callback".length);
    res.statusCode = 302;
    res.setHeader("location", `${base}${query.startsWith("?") ? query : ""}`);
    res.end();
    return;
  }
  next();
}

export default defineConfig({
  test: {
    // `server/` and the Pages backend-free guard are `node --test` (see
    // `package.json` `test` / `test:relay`), not Vitest.
    exclude: [
      ...configDefaults.exclude,
      "server/**",
      "scripts/pages-backend-free-guard.test.mjs",
    ],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    setupFiles: ["./src/host/test-setup.ts", "./src/host/test-queries.ts"],
  },
  base,
  define: { "process.env.NODE_DEBUG_NATIVE": "false" },
  resolve: {
    alias: {
      // Subpaths must precede the bare package alias; otherwise Vite resolves
      // `@opensesame/os-domain/authority-templates` as `browser.ts/authority-templates`.
      "@opensesame/os-domain/authority-templates": osDomainAuthorityTemplates,
      "@opensesame/os-domain/wallet": osDomainWallet,
      "@opensesame/os-domain": osDomainBrowser,
    },
  },
  optimizeDeps: {
    exclude: ["@opensesame/os-domain"],
    // Reached late (the import pipeline, SOPS sealing), so the dev server
    // only finds them mid-session, re-optimizes and reloads the page: a cold
    // first load navigated four times and sat blank until it settled. Named
    // through app-core, which owns them.
    include: [
      "@opensesame/app-core > kdbxweb",
      "@opensesame/app-core > hash-wasm",
      "@opensesame/app-core > @noble/ciphers/aes",
    ],
    esbuildOptions: { target: "es2022" },
  },
  server: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  build: {
    // esbuild 0.28 cannot downlevel some destructuring forms used by react-router
    // to Vite's default legacy browser set; GitHub Pages clients are modern.
    target: ["es2022", "chrome100", "firefox100", "safari15"],
    chunkSizeWarningLimit: entryChunkWarningKb,
    rollupOptions: {
      onwarn(warning, warn) {
        // @scure/base (2.4.0, the latest) explains its pure annotations in a
        // line comment that quotes one. Rollup reads the quote as a misplaced
        // annotation and drops the comment, which is the right outcome.
        if (
          warning.code === "INVALID_ANNOTATION" &&
          warning.id?.includes("/@scure/base/")
        )
          return;
        warn(warning);
      },
      output: {
        // Merge a chunk under 5 KB into one that every path loading it
        // already loads, so the explicit capability chunks (see
        // `capability-compose-plugin.mjs`) do not leave dozens of tiny
        // shared chunks that gzip worse apart than together. Larger values
        // fold small optional chunks (Tailnet sync's) into `main`, which
        // is "safe" to Rollup — everything loads `main` — and wrong here.
        experimentalMinChunkSize: 5_000,
      },
      // Every HTML entry is listed here; `capabilityCompose()`'s config hook
      // removes the ones owned by a capability a hardened build excludes
      // (`auth/redirect.html` → identity.ambient-sso) and partitions optional
      // modules into `cap-<capability>` chunks. `main` is always kept.
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        msalRedirect: fileURLToPath(
          new URL("./auth/redirect.html", import.meta.url),
        ),
      },
    },
  },
  // Dependency pre-bundling in dev has its own target and hits the same limitation.
  esbuild: { target: "es2022" },
  // Workers are constructed with `{ type: "module" }`; Vite's default IIFE
  // worker output does not load that way, and Chromium reports the failure
  // as a bare `error` event with no message. Emitting real ES modules is
  // what makes a module worker start at all. Every target engine here
  // (Chrome 100, Firefox 100, Safari 15) supports module workers.
  worker: { format: "es" },
  plugins: [
    githubAppRelayPlugin(),
    // `siop-metadata.json` for relying parties (ADR 0161), emitted at the base.
    siopMetadata(),
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
          handlePagesDevRequest(req, res, next, base);
        });
      },
      // Vite injects an inline React-refresh hook in index.html. Production
      // has no inline scripts, so the meta CSP stays strict there.
      transformIndexHtml: {
        order: "pre",
        handler(html, ctx) {
          const liveHtml = impeccableDevHtml(
            html,
            Boolean(ctx.server),
            process.env.OPENSESAME_IMPECCABLE_LIVE === "1",
          );
          if (!ctx.server) return liveHtml;
          return liveHtml.replace(
            "script-src 'self'",
            "script-src 'self' 'unsafe-inline'",
          );
        },
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
        globPatterns: ["**/*.{js,wasm,css,html,svg,ico,webp,woff2,json}"],
        maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
      },
      devOptions: { enabled: true, navigateFallback: "index.html" },
    }),
    // Capability composition (ownership.md §4.6): virtual MODULE_TABLE and
    // DISTRIBUTION, hardened pruning, `dist/capability-graph.json` and the
    // forbidden-reachability gate. Placed after VitePWA so its post-order
    // closeBundle sees `sw.js`; its normal-order closeBundle prunes excluded
    // public files before VitePWA globs the precache manifest. Env:
    // OPENSESAME_CAPABILITY_PROFILE, OPENSESAME_BUILD_MODE, OPENSESAME_GRAPH_GATE.
    capabilityCompose(),
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
