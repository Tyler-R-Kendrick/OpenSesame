/** Ship the source-built original-node browser client and its verified native HTTPS bridge. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { prepareNativeDistribution } from "../../../tools/pwa-tailscale-native-http/prepare-distribution.mjs";
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
/** Every normal Vite caller prepares and verifies the mandatory source-built native graph. */
export async function loadTailscaleAssets() {
  const result = await prepareNativeDistribution(
    fileURLToPath(new URL("../../..", import.meta.url)),
    manifest.native.sourceMetadataSha256,
    manifest.native.manifestSha256,
  );
  const records = {
    ...result.manifest.assets,
    license: result.manifest.license,
    notices: result.manifest.upstreamNotices,
  };
  if (
    result.assets.size !== Object.keys(TAILSCALE_ASSETS).length ||
    result.manifest.sourceCommit !== manifest.native.sourceCommit ||
    result.manifest.compilerCommit !== manifest.native.compilerCommit
  )
    throw new Error("Native Tailscale distribution provenance differs.");
  for (const [kind, path] of Object.entries(TAILSCALE_ASSETS)) {
    if (records[kind]?.path !== path || !result.assets.has(path))
      throw new Error("Native Tailscale deployment asset mapping differs.");
  }
  assertTailscaleHash(
    result.assets.get(TAILSCALE_ASSETS.wasm),
    TAILSCALE_SDK.gzipHash,
  );
  assertTailscaleHash(
    result.assets.get(TAILSCALE_ASSETS.runtime),
    TAILSCALE_SDK.runtimeHash,
  );
  assertTailscaleHash(
    result.assets.get(TAILSCALE_ASSETS.nativeHTTP),
    TAILSCALE_SDK.nativeHTTPHash,
  );
  assertTailscaleHash(
    gunzipSync(result.assets.get(TAILSCALE_ASSETS.wasm)),
    TAILSCALE_SDK.wasmHash,
  );
  return result.assets;
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
    async configureServer(server) {
      if (!enabled) return;
      assets ??= await loadTailscaleAssets();
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
    async generateBundle(_options, bundle) {
      if (!enabled) return;
      assets ??= await loadTailscaleAssets();
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
