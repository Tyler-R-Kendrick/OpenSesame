import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TAILSCALE_ASSETS,
  TAILSCALE_SDK,
  assertTailscaleHash,
  attachTailscaleAssets,
  extractTailscaleRuntime,
  loadTailscaleAssets,
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
