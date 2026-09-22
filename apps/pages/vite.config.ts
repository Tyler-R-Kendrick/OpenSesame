import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { capabilityCompose } from "./scripts/capability-compose-plugin.mjs";
import { githubAppRelayPlugin } from "./scripts/github-app-relay-plugin.mjs";
import { impeccableDevHtml } from "./scripts/impeccable-dev.mjs";
import { crossOriginOpenerPolicy } from "./src/lib/opener-policy.ts";

const base = process.env.VITE_BASE ?? "/OpenSesame/";
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
    testTimeout: 20_000,
    hookTimeout: 20_000,
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
    rollupOptions: {
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
  plugins: [
    githubAppRelayPlugin(),
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
