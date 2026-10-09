import assert from "node:assert/strict";
import { test } from "vitest";
import { lazyLeafChunk } from "./capability-lazy-leaves.mjs";

test("pins the optional Tailnet pairing leaf without changing ownership of other modules", () => {
  const file =
    "/workspace/packages/app-core/src/lib/tailnet-sync/plugin-pairing.ts";
  const entry = {
    classification: "optional",
    capability: "networking.tailnet",
  };
  assert.equal(lazyLeafChunk(file, entry), "tailnet-plugin-pairing");
  assert.equal(
    lazyLeafChunk(file.replaceAll("/", "\\"), entry),
    "tailnet-plugin-pairing",
  );
  assert.equal(
    lazyLeafChunk(file, { classification: "shared", capability: null }),
    undefined,
  );
  assert.equal(
    lazyLeafChunk(file, {
      classification: "optional",
      capability: "connectors.external",
    }),
    undefined,
  );
  assert.equal(
    lazyLeafChunk(
      "/workspace/packages/app-core/src/lib/tailnet-sync/plugin-daemon.ts",
      entry,
    ),
    undefined,
  );
});
