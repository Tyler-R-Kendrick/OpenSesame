import assert from "node:assert/strict";
import { test } from "vitest";
import {
  TAILSCALE_ASSETS,
  TAILSCALE_SDK,
  assertTailscaleHash,
  attachTailscaleAssets,
  loadTailscaleAssets,
  tailscaleWorkerFileName,
} from "./tailscale-wasm-assets.mjs";
test.skipIf(process.arch !== "x64")(
  "ships exact source-built native WASM, isolated runtime, jitless bridge and complete notices",
  // A cold cache may wait on the 600s preparation lock, download two archives
  // (125s each), then run the separately bounded 600s native build.
  { timeout: 1_500_000 },
  async () => {
    const assets = await loadTailscaleAssets();
    assert.equal(assets.get(TAILSCALE_ASSETS.wasm).length, 6774176);
    assert.equal(assets.get(TAILSCALE_ASSETS.runtime).length, 8078);
    assert.match(
      assets.get(TAILSCALE_ASSETS.runtime).toString(),
      /globalThis\.Go\s*=\s*class/,
    );
    assert.doesNotMatch(
      assets.get(TAILSCALE_ASSETS.runtime).toString(),
      /document\./,
    );
    assert.match(assets.get(TAILSCALE_ASSETS.license).toString(), /Tailscale/);
    assert.match(assets.get(TAILSCALE_ASSETS.license).toString(), /Go Authors/);
    assert.match(
      assets.get(TAILSCALE_ASSETS.license).toString(),
      /Zod4 runtime/,
    );
    assert.equal(assets.get(TAILSCALE_ASSETS.nativeHTTP).length, 28377);
    assertTailscaleHash(
      assets.get(TAILSCALE_ASSETS.nativeHTTP),
      TAILSCALE_SDK.nativeHTTPHash,
    );
    assert.match(
      assets.get(TAILSCALE_ASSETS.nativeHTTP).toString(),
      /jitless:!0/,
    );
    assert.equal(assets.get(TAILSCALE_ASSETS.notices).length, 16084);
    assertTailscaleHash(
      assets.get(TAILSCALE_ASSETS.runtime),
      TAILSCALE_SDK.runtimeHash,
    );
  },
);

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
test("refuses modified/unpinned JavaScript and WASM before build emission", () => {
  assert.throws(
    () =>
      assertTailscaleHash(
        "(()=>{globalThis.Go=class{}})();",
        TAILSCALE_SDK.runtimeHash,
      ),
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
