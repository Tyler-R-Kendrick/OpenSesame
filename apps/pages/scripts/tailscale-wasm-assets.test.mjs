import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TAILSCALE_ASSETS,
  TAILSCALE_SDK,
  assertTailscaleHash,
  attachTailscaleAssets,
  extractTailscaleRuntime,
  loadTailscaleAssets,
  tailscaleWorkerFileName,
} from "./tailscale-wasm-assets.mjs";
test("ships the exact pinned official WASM and intact isolated Go runtime with both licenses", () => {
  const assets = loadTailscaleAssets();
  assert.equal(assets.get(TAILSCALE_ASSETS.wasm).length, 6600192);
  assert.equal(assets.get(TAILSCALE_ASSETS.runtime).length, 8016);
  assert.match(assets.get(TAILSCALE_ASSETS.runtime), /globalThis\.Go=class/);
  assert.doesNotMatch(assets.get(TAILSCALE_ASSETS.runtime), /document\./);
  assert.match(assets.get(TAILSCALE_ASSETS.license), /Tailscale/);
  assert.match(assets.get(TAILSCALE_ASSETS.license), /Go Authors/);
  assertTailscaleHash(
    assets.get(TAILSCALE_ASSETS.runtime),
    TAILSCALE_SDK.runtimeHash,
  );
});

test("identifies only the dedicated Tailscale worker entry", () => {
  assert.equal(
    tailscaleWorkerFileName({
      facadeModuleId: "/app/src/modules/networking.tailnet/browser/worker.ts",
    }),
    "assets/tailscale-node-[hash].js",
  );
  for (const facadeModuleId of [undefined, "/app/src/workers/other.ts"])
    assert.equal(
      tailscaleWorkerFileName({ facadeModuleId }),
      "assets/[name]-[hash].js",
    );
});

test("approved networking cache owns the actual emitted dedicated worker before first use", () => {
  const owner = () => ({
    type: "chunk",
    modules: {
      "/app/src/modules/networking.tailnet/browser/controller.ts": {},
    },
  });
  const controller = owner();
  const worker = "assets/tailscale-node-aBc123_-.js";
  const unrelated = { type: "asset", source: "other" };
  attachTailscaleAssets({
    controller,
    [worker]: { type: "asset", source: "worker" },
    "assets/other.js": unrelated,
  });
  assert.deepEqual(
    [...controller.viteMetadata.importedAssets].sort(),
    [...Object.values(TAILSCALE_ASSETS), worker].sort(),
  );
  assert.equal(unrelated.viteMetadata, undefined);
  assert.throws(
    () => attachTailscaleAssets({ controller: owner() }),
    /exactly one emitted dedicated worker/,
  );
  assert.throws(
    () =>
      attachTailscaleAssets({
        controller: owner(),
        [worker]: { type: "asset" },
        "assets/tailscale-node-second.js": { type: "asset" },
      }),
    /exactly one emitted dedicated worker/,
  );
});
test("refuses modified/unpinned JavaScript before any AST extraction or build emission", () => {
  assert.throws(
    () => extractTailscaleRuntime("(()=>{globalThis.Go=class{}})();"),
    /digest/,
  );
  assert.throws(
    () => assertTailscaleHash("modified", TAILSCALE_SDK.wasmHash),
    /digest/,
  );
});

test("attaches deployment assets only to the owning networking chunks for offline approval", () => {
  const owner = {
    type: "chunk",
    modules: { "/app/src/modules/networking.tailnet/runtime.ts": {} },
  };
  const unrelated = {
    type: "chunk",
    modules: { "/app/src/modules/connectors.external/runtime.ts": {} },
  };
  attachTailscaleAssets({ owner, unrelated });
  assert.deepEqual(
    [...owner.viteMetadata.importedAssets].sort(),
    Object.values(TAILSCALE_ASSETS).sort(),
  );
  assert.equal(unrelated.viteMetadata, undefined);
  assert.throws(
    () => attachTailscaleAssets({ unrelated }),
    /distributed networking runtime/,
  );
});
