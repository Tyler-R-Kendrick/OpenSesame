import assert from "node:assert/strict";
import { test } from "vitest";
import { bundleChunk } from "./bundle-chunk.mjs";

test("schema initialization remains an evaluated dependency without workers", () => {
  const file = "/x/packages/app-core/src/lib/zod-jitless.ts";
  assert.equal(bundleChunk(file), "schema-csp");
  assert.equal(bundleChunk(file.replaceAll("/", "\\")), "schema-csp");
  assert.equal(bundleChunk(`${file}x`), undefined);
});

test("renderer and router keep their own chunks", () => {
  assert.equal(bundleChunk("/x/node_modules/react-dom/client.js"), "react-dom");
  assert.equal(bundleChunk("/x/node_modules/react/index.js"), "react-dom");
  assert.equal(
    bundleChunk("/x/node_modules/react-router/dist/index.js"),
    "react-router",
  );
});

test("named lazy chunks stay addressable by file name", () => {
  assert.equal(
    bundleChunk("/x/packages/app-core/src/lib/device-identity-host.ts"),
    "device-identity-host",
  );
  assert.equal(
    bundleChunk("/x/node_modules/@noble/curves/ed25519.js"),
    "noble-crypto",
  );
  // Hashes used by bootstrap stay outside the optional curves chunk, for
  // both the legacy /esm/ layout and v2 package-root exports.
  for (const module of ["esm/sha256.js", "sha2.js", "sha3.js", "utils.js"]) {
    assert.equal(
      bundleChunk(`/x/node_modules/@noble/hashes/${module}`),
      undefined,
    );
  }
});

test("peer-trust modules shared by live and sharing graphs share one chunk", () => {
  for (const name of ["handshake", "webcrypto", "peers"]) {
    assert.equal(
      bundleChunk(`/x/packages/app-core/src/lib/peer-trust/${name}.ts`),
      "peer-trust",
    );
  }
  // Bootstrap-imported peer-trust modules are not pulled into the lazy chunk.
  assert.equal(
    bundleChunk("/x/packages/app-core/src/lib/peer-trust/db.ts"),
    undefined,
  );
});

test("windows separators and unmatched modules fall through", () => {
  assert.equal(
    bundleChunk("C:\\x\\node_modules\\react-dom\\client.js"),
    "react-dom",
  );
  assert.equal(bundleChunk("/x/src/main.tsx"), undefined);
});
