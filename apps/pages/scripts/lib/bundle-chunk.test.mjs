import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "vitest";
import { capabilityCompose } from "../capability-compose-plugin.mjs";
import { bundleChunk } from "./bundle-chunk.mjs";
import { makeFixtureTree } from "./capability-fixtures.mjs";
import { lazyLeafChunk } from "./capability-lazy-leaves.mjs";

const matches = [
  ["/repo/node_modules/react/index.js", "react-dom"],
  ["/repo/node_modules/react/jsx-runtime.js", "react-dom"],
  ["/repo/node_modules/react-dom/client.js", "react-dom"],
  ["/repo/node_modules/scheduler/index.js", "react-dom"],
  ["/repo/node_modules/react-router/index.js", "react-router"],
  ["/repo/node_modules/react-router-dom/dist/index.js", "react-router"],
  [
    "/repo/node_modules/.pnpm/react@19.2.3/node_modules/react/index.js",
    "react-dom",
  ],
  ["/repo/node_modules/react/index.js?commonjs-proxy", "react-dom"],
  [
    "/repo/packages/app-core/src/lib/device-identity-host.ts",
    "device-identity-host",
  ],
  ["/repo/src/lib/device-identity-host.ts?worker", "device-identity-host"],
];

test.each(matches)("preserves the existing chunk for %s", (id, expected) => {
  assert.equal(bundleChunk(id), expected);
  assert.equal(bundleChunk(id.replaceAll("/", "\\")), expected);
});

test("retains the original substring and precedence semantics", () => {
  assert.equal(
    bundleChunk("/repo/lib/device-identity-host.tsx"),
    "device-identity-host",
  );
  assert.equal(
    bundleChunk("/node_modules/react-router/node_modules/react/index.js"),
    "react-dom",
  );
  assert.equal(
    bundleChunk("\0virtual:/repo/node_modules/react/index.js"),
    "react-dom",
  );
});

test.each([
  "react",
  "/repo/node_modules/reactive/index.js",
  "/repo/node_modules/react-dom-extra/index.js",
  "/repo/node_modules/scheduler-extra/index.js",
  "/repo/node_modules/react-router-extra/index.js",
  "/repo/src/lib/device-identity.ts",
  "/repo/src/lib/device-inbox.ts",
  "/repo/lib/device-identity-host-extra.ts",
  "/repo/src/main.tsx",
  "/repo/packages/app-core/src/lib/secret-backends/onepassword-sdk-loader.ts",
  "/repo/apps/pages/src/modules/networking.tailnet/browser/worker.ts",
  "/repo/packages/app-core/src/lib/command-bar/interpret-generate-object.ts",
  "/repo/node_modules/ai/dist/index.mjs",
])("leaves existing capability placement alone for %s", (id) => {
  assert.equal(bundleChunk(id), undefined);
});

test("preserves the local AI and native SDK lazy owner pins", () => {
  const cases = [
    [
      "/repo/packages/app-core/src/lib/command-bar/interpret-generate-object.ts",
      "support.local-ai",
      "local-ai-sdk-entry",
    ],
    [
      "/repo/node_modules/ai/dist/index.mjs",
      "support.local-ai",
      "vendor-ai-sdk",
    ],
    [
      "/repo/packages/app-core/src/lib/secret-backends/onepassword-sdk-loader.ts",
      "connectors.external",
      "secret-backend-onepassword-sdk",
    ],
  ];
  for (const [id, capability, expected] of cases) {
    assert.equal(bundleChunk(id), undefined);
    assert.equal(
      lazyLeafChunk(id, { classification: "optional", capability }),
      expected,
    );
    assert.equal(
      lazyLeafChunk(id, { classification: "shared", capability: null }),
      undefined,
    );
  }
});

test("the actual capability plugin keeps partition priority and this fallback", async () => {
  const tree = makeFixtureTree();
  try {
    const [plugin] = capabilityCompose({
      appRoot: tree.appRoot,
      repoRoot: tree.tmpRoot,
      inventory: tree.inventory,
      mode: "selective",
      env: {},
    });
    const config = {
      build: { rollupOptions: { output: { manualChunks: bundleChunk } } },
    };
    await plugin.config(config, { command: "build", mode: "production" });
    const output = config.build.rollupOptions.output;
    assert.equal(output.onlyExplicitManualChunks, true);
    assert.equal(
      output.manualChunks(
        `${tree.appRoot}/src/modules/sharing.drops/runtime.ts`,
      ),
      "cap-sharing.drops",
    );
    assert.equal(
      output.manualChunks(`${tree.tmpRoot}/node_modules/react/index.js`),
      "react-dom",
    );
    assert.equal(
      output.manualChunks(`${tree.appRoot}/src/lib/device-identity-host.ts`),
      "device-identity-host",
    );
    assert.equal(
      output.manualChunks(`${tree.appRoot}/src/lib/unowned.ts`),
      undefined,
    );
  } finally {
    rmSync(tree.tmpRoot, { recursive: true, force: true });
  }
});
