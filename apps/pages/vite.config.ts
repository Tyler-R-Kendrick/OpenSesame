import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { configDefaults } from "vitest/config";
import { crossOriginOpenerPolicy } from "../../packages/app-core/src/lib/opener-policy.ts";
import { pwaManifest } from "./pwa-manifest.js";
import { aiBrowserModels } from "./scripts/ai-browser-models.mjs";
import { bundleChunk } from "./scripts/bundle-chunk.mjs";
import { capabilityCompose } from "./scripts/capability-compose-plugin.mjs";
import { githubAppRelayPlugin } from "./scripts/github-app-relay-plugin.mjs";
import { impeccableDevHtml } from "./scripts/impeccable-dev.mjs";
import { kdbxNativeDOM } from "./scripts/kdbx-native-dom-plugin.mjs";
import { dependencyRoot } from "./scripts/lib/dependency-root.mjs";
import { writePrivateSnapshot } from "./scripts/lib/private-files.mjs";
import { mcpBrowserValidator } from "./scripts/mcp-browser-validator.mjs";
import { nativeClientMetadataPlugin } from "./scripts/native-client-metadata-plugin.mjs";
import { nativeSamlCallbackPlugin } from "./scripts/native-saml-callback-plugin.mjs";
import { onePasswordWasmAssets } from "./scripts/onepassword-wasm-assets.mjs";
import { samlBrowserCrypto } from "./scripts/saml-browser-crypto.mjs";
import { securityProfile } from "./scripts/security-profile.mjs";
import { sharedWorkerGraph } from "./scripts/shared-worker-graph.mjs";
import { shellBuildMetadata } from "./scripts/shell-build-metadata-plugin.mjs";
import { siopMetadata } from "./scripts/siop-metadata-plugin.mjs";
import {
  tailscaleWasmAssets,
  tailscaleWorkerFileName,
} from "./scripts/tailscale-wasm-assets.mjs";
import { vercelOidcNamespace } from "./scripts/vercel-oidc-namespace.mjs";
import { zodCsp } from "./scripts/zod-csp-plugin.mjs";

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
/**
 * app-core already depends on this copy. @scure/bip32 and nostr-tools pin
 * curves 2.0.1, which emits a second secp256k1 (Point, getPublicKey, sign
 * and verify with `prehash: false`, schnorr). One resolution keeps a single
 * copy. Those callers use the surface 2.4.0 still exports. The copy is the one
 * app-core resolves, wherever the install placed it.
 */
const nobleCurves = dependencyRoot(
  fileURLToPath(
    new URL("../../packages/app-core/package.json", import.meta.url),
  ),
  "@noble/curves",
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
        writePrivateSnapshot(
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
    // The relay's suites under `server/` are `node --test` (`test:relay`).
    // Popup arming order is a Vitest suite
    // (`linear-consent-popup-arming.test.mjs`), with the other `scripts/lib`
    // contracts. Root `vitest run scripts/lib` discovers `**/scripts/lib/**`,
    // so that file cannot stay on `node:test`.
    exclude: [...configDefaults.exclude, "server/**"],
    // Real PIN/KDF and bundling suites share a bounded CPU budget, including related runs.
    maxWorkers: 1,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Real TLS/native integration fixtures occasionally miss a short deadline
    // when the whole 7k-test suite is under load. Retry once; deterministic
    // product failures still fail both attempts.
    retry: 1,
    setupFiles: ["./src/host/test-setup.ts", "./src/host/test-queries.ts"],
  },
  base,
  define: {
    "process.env.NODE_DEBUG_NATIVE": "false",
    __NATIVE_GOOGLE_HEADER_SECURITY__: JSON.stringify(
      securityProfile(process.env).headerSecurity,
    ),
  },
  resolve: {
    alias: {
      // Subpaths must precede the bare package alias; otherwise Vite resolves
      // `@opensesame/os-domain/authority-templates` as `browser.ts/authority-templates`.
      "@opensesame/os-domain/authority-templates": osDomainAuthorityTemplates,
      "@opensesame/os-domain/wallet": osDomainWallet,
      "@opensesame/os-domain": osDomainBrowser,
      "@noble/curves": nobleCurves,
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
      "@opensesame/app-core > @noble/ciphers/aes.js",
    ],
    esbuildOptions: { target: "es2022" },
  },
  server: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  build: {
    modulePreload: {
      // Browser module imports load their full graph; retain entry HTML hints and
      // Vite's separately awaited CSS without repeating JS tables per leaf.
      resolveDependencies: (_url, dependencies, { hostType }) =>
        hostType === "html" ? dependencies : [],
    },
    // Compress the shipped offline PWA without changing its capability graph.
    minify: "terser",
    terserOptions: {
      // Keep minification aligned with the modern build target below.
      compress: { passes: 4, pure_getters: true, ecma: 2022 },
      format: { comments: false, ecma: 2022 },
      mangle: { toplevel: true },
    },
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
        // Merge a chunk under 64 KB into one that every path loading it
        // already loads. The precache gzips each file alone; a 64 KB floor
        // reduces that repeated compression overhead. A pure chunk still
        // folds into a neighbour at this floor. Pin a chunk that must keep its
        // name (`device-identity-host` below; web-push enrolment in
        // `capability-lazy-leaves.mjs`) so the bootstrap does not
        // static-import an optional module (ADR 0130 §4) and the device
        // walks can still import the host by file name.
        experimentalMinChunkSize: 64_000,
        manualChunks: bundleChunk,
      },
      // Every HTML entry is listed here; `capabilityCompose()`'s config hook
      // removes the ones owned by a capability a hardened build excludes
      // (`auth/redirect.html` → identity.ambient-sso) and partitions optional
      // modules into `cap-<capability>` chunks. `main` is always kept.
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        linearRedirect: fileURLToPath(
          new URL("./auth/linear.html", import.meta.url),
        ),
        nativeConnectorRedirect: fileURLToPath(
          new URL("./auth/native-connector.html", import.meta.url),
        ),
        nativeImplicitRedirect: fileURLToPath(
          new URL("./auth/native-implicit.html", import.meta.url),
        ),
        nativeGoogleConsent: fileURLToPath(
          new URL("./auth/native-google.html", import.meta.url),
        ),
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
  worker: {
    format: "es",
    rollupOptions: {
      output: { entryFileNames: tailscaleWorkerFileName },
    },
  },
  plugins: [
    shellBuildMetadata(),
    zodCsp(),
    aiBrowserModels(fileURLToPath(new URL("../..", import.meta.url))),
    vercelOidcNamespace(fileURLToPath(new URL("../..", import.meta.url))),
    process.env.OPENSESAME_AI_COMPLETION_VERIFY === "1" && {
      name: "ai-completion-verifier-entry",
      apply: "build",
      transformIndexHtml: {
        order: "pre",
        handler(html, ctx) {
          if (
            ctx.filename !==
            fileURLToPath(new URL("./index.html", import.meta.url))
          )
            return html;
          const main = '<script type="module" src="/src/main.tsx"></script>';
          if (html.split(main).length !== 2)
            throw new Error(
              "AI verifier requires exactly one original main entry",
            );
          const verifier =
            '<script type="module" src="/src/verification/ai-completion-verifier.ts"></script>';
          return html.replace(main, `${verifier}\n${main}`);
        },
      },
    },
    mcpBrowserValidator(fileURLToPath(new URL("../..", import.meta.url))),
    samlBrowserCrypto(fileURLToPath(new URL("../..", import.meta.url))),
    kdbxNativeDOM(fileURLToPath(new URL("../..", import.meta.url))),
    nativeClientMetadataPlugin(base),
    nativeSamlCallbackPlugin(),
    githubAppRelayPlugin(),
    // `siop-metadata.json` for relying parties (ADR 0161), emitted at the base.
    siopMetadata(),
    sharedWorkerGraph(),
    tailscaleWasmAssets(),
    onePasswordWasmAssets(),
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
      manifest: pwaManifest,
      injectManifest: {
        globPatterns: [
          "**/*.{js,wasm,gz,css,html,svg,png,ico,webp,woff2,json}",
        ],
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
