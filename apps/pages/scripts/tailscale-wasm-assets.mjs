/** Pin and extract the official browser client without xterm's main-document UI. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import ts from "typescript";
import { composeState } from "./lib/capability-compose-state.mjs";

const manifest = JSON.parse(
  readFileSync(
    new URL(
      "../src/lib/capabilities/tailscale-artifacts.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
export const TAILSCALE_SDK = Object.freeze(manifest.sdk);
export const TAILSCALE_ASSETS = Object.freeze(manifest.assets);
/** Give this dedicated worker an explicit build identity without renaming other workers. */
export function tailscaleWorkerFileName(chunk) {
  return chunk.facadeModuleId
    ?.replaceAll("\\", "/")
    .endsWith("/src/modules/networking.tailnet/browser/worker.ts")
    ? "assets/tailscale-node-[hash].js"
    : "assets/[name]-[hash].js";
}
export function assertTailscaleHash(bytes, expected) {
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error(
      "Pinned Tailscale artifact digest differs; review the SDK upgrade.",
    );
}
/** Preserve the complete upstream statement byte-for-byte; never rewrite Go glue. */
export function extractTailscaleRuntime(source) {
  assertTailscaleHash(source, TAILSCALE_SDK.jsHash);
  const ast = ts.createSourceFile(
    "pkg.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const statements = ast.statements.filter(
    (node) =>
      ts.isExpressionStatement(node) &&
      node.getText(ast).includes("globalThis.Go=class"),
  );
  if (statements.length !== 1)
    throw new Error("Unexpected Tailscale Go runtime statement count.");
  const runtime = statements[0].getText(ast);
  assertTailscaleHash(runtime, TAILSCALE_SDK.runtimeHash);
  return runtime;
}
export function loadTailscaleAssets() {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("@tailscale/connect/package.json"));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (manifest.version !== TAILSCALE_SDK.version)
    throw new Error("Unpinned Tailscale SDK version.");
  const gzip = readFileSync(join(root, "main.wasm.gz"));
  assertTailscaleHash(gzip, TAILSCALE_SDK.gzipHash);
  assertTailscaleHash(gunzipSync(gzip), TAILSCALE_SDK.wasmHash);
  const runtime = extractTailscaleRuntime(
    readFileSync(join(root, "pkg.js"), "utf8"),
  );
  const license = [
    "Official @tailscale/connect browser WASM client",
    `Version: ${TAILSCALE_SDK.version}`,
    "Go runtime: go1.26.6",
    readFileSync(
      new URL("./vendor/tailscale-connect.LICENSE", import.meta.url),
      "utf8",
    ),
    readFileSync(
      new URL("./vendor/go-runtime.LICENSE", import.meta.url),
      "utf8",
    ),
  ].join("\n\n");
  return new Map([
    [TAILSCALE_ASSETS.wasm, gzip],
    [TAILSCALE_ASSETS.runtime, runtime],
    [TAILSCALE_ASSETS.license, license],
  ]);
}
export function tailscaleWasmAssets() {
  let enabled = false;
  let base = "/";
  let assets;
  return {
    name: "opensesame-tailscale-wasm-assets",
    async config(config, { command }) {
      const state = await composeState({}, config, command);
      enabled = !state.isExcluded("networking.tailnet");
      base = config.base ?? "/";
    },
    configureServer(server) {
      if (!enabled) return;
      assets ??= loadTailscaleAssets();
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0]?.slice(base.length);
        const value = assets.get(path);
        if (value === undefined) return next();
        res.setHeader(
          "Content-Type",
          path.endsWith(".js") ? "text/javascript" : "application/octet-stream",
        );
        res.end(value);
      });
    },
    generateBundle(_options, bundle) {
      if (!enabled) return;
      assets ??= loadTailscaleAssets();
      for (const [fileName, source] of assets)
        this.emitFile({ type: "asset", fileName, source });
      attachTailscaleAssets(bundle);
    },
  };
}

/** Declare actual browser runtime dependencies for the approved-capability offline plan. */
export function attachTailscaleAssets(bundle) {
  const workers = Object.keys(bundle).filter(
    (file) =>
      bundle[file].type === "asset" &&
      /^assets\/tailscale-node-[A-Za-z0-9_-]+\.js$/.test(file),
  );
  let attached = false;
  for (const output of Object.values(bundle)) {
    if (
      output.type !== "chunk" ||
      !Object.keys(output.modules).some((id) =>
        id.replaceAll("\\", "/").includes("/src/modules/networking.tailnet/"),
      )
    )
      continue;
    output.viteMetadata ??= {
      importedCss: new Set(),
      importedAssets: new Set(),
    };
    for (const file of Object.values(TAILSCALE_ASSETS))
      output.viteMetadata.importedAssets.add(file);
    if (
      Object.keys(output.modules).some((id) =>
        id
          .replaceAll("\\", "/")
          .endsWith("/networking.tailnet/browser/controller.ts"),
      )
    ) {
      if (workers.length !== 1)
        throw new Error(
          "Tailscale controller needs exactly one emitted dedicated worker.",
        );
      output.viteMetadata.importedAssets.add(workers[0]);
    }
    attached = true;
  }
  if (!attached)
    throw new Error(
      "Tailscale assets need their distributed networking runtime.",
    );
}
