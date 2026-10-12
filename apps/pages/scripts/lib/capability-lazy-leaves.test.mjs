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

test("pins the relay client to its capability's chunk and nothing else under vault-relay", () => {
  const entry = { classification: "optional", capability: "sharing.relay" };
  assert.equal(
    lazyLeafChunk(
      "/workspace/packages/app-core/src/lib/vault-relay/client.ts",
      entry,
    ),
    "cap-sharing.relay",
  );
  assert.equal(
    lazyLeafChunk(
      "/workspace/packages/app-core/src/lib/vault-relay/client.ts",
      {
        classification: "shared",
        capability: null,
      },
    ),
    undefined,
  );
  assert.equal(
    lazyLeafChunk(
      "/workspace/packages/app-core/src/lib/vault-relay/other.ts",
      entry,
    ),
    undefined,
  );
});

test("pins the claim different-link control on identity.ceremonies", () => {
  const file =
    "/workspace/apps/pages/src/modules/identity.ceremonies/ClaimDifferentLink.tsx";
  const entry = {
    classification: "optional",
    capability: "identity.ceremonies",
  };
  assert.equal(lazyLeafChunk(file, entry), "cap-identity.claim-different-link");
});

test("pins CLI authorize UI on identity.local-iam", () => {
  const file =
    "/workspace/apps/pages/src/modules/identity.local-iam/cli-authorize-panel.tsx";
  const entry = {
    classification: "optional",
    capability: "identity.local-iam",
  };
  assert.equal(lazyLeafChunk(file, entry), "cli-authorize");
});

test("pins optional vault.security-checks app-core leaf when Rollup classifies it shared", () => {
  const file = "/workspace/packages/app-core/src/lib/vault/security-checks.ts";
  const entry = {
    classification: "shared",
    capability: null,
  };
  assert.equal(lazyLeafChunk(file, entry), "cap-vault.security-checks");
  assert.equal(
    lazyLeafChunk(file.replaceAll("/", "\\"), entry),
    "cap-vault.security-checks",
  );
});
