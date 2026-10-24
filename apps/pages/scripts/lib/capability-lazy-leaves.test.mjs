import assert from "node:assert/strict";
import { test } from "vitest";
import {
  commonjsShimChunk,
  lazyLeafChunk,
  leafSource,
  secretBackendSdkChunk,
} from "./capability-lazy-leaves.mjs";

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

test("pins CLI app-integration crypto leaves on identity.local-iam", () => {
  const entry = {
    classification: "optional",
    capability: "identity.local-iam",
  };
  assert.equal(
    lazyLeafChunk(
      "/workspace/packages/app-core/src/lib/cli-app-integration/device-crypto.ts",
      entry,
    ),
    "cli-app-integration-crypto",
  );
  assert.equal(
    lazyLeafChunk(
      "/workspace/packages/app-core/src/lib/cli-app-integration/device-crypto.ts",
      { classification: "core", capability: "shell.navigation" },
    ),
    "cli-app-integration-crypto",
  );
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

test("keeps password-reset mailbox leaves within their matching optional capability", () => {
  const entry = { classification: "optional", capability: "ai.password-reset" };
  for (const name of [
    "handled",
    "jmap",
    "legacy-emails",
    "mail-type.generated",
    "mail-type",
    "mailbox-connection",
    "mailbox-store",
  ]) {
    const path = `/workspace/packages/app-core/src/lib/password-reset/${name}.ts`;
    assert.equal(lazyLeafChunk(path, entry), "cap-ai.password-reset");
    assert.equal(
      lazyLeafChunk(path.replaceAll("/", "\\"), entry),
      "cap-ai.password-reset",
    );
    assert.equal(
      lazyLeafChunk(path, { classification: "shared", capability: null }),
      undefined,
    );
    assert.equal(
      lazyLeafChunk(path, {
        classification: "optional",
        capability: "connectors.external",
      }),
      undefined,
    );
  }
});

test("keeps backup SDKs and authority UI in separate lazy capability chunks", () => {
  const paths = [
    [
      "/packages/app-core/src/lib/secret-backends/bitwarden.worker.ts",
      "connectors.external",
      "secret-backends",
    ],
    [
      "/node_modules/@1password/save-button/dist/index.js",
      "connectors.external",
      "vendor-1password-save",
    ],
    [
      "/src/sections/access/HostedRequestsPanel.tsx",
      "access.authority",
      "cap-access.authority",
    ],
  ];
  for (const [path, capability, chunk] of paths) {
    assert.equal(
      lazyLeafChunk(path, { classification: "optional", capability }),
      chunk,
    );
    assert.equal(
      lazyLeafChunk(path, {
        classification: "core",
        capability: "shell.navigation",
      }),
      undefined,
    );
    assert.equal(
      lazyLeafChunk(path, {
        classification: "optional",
        capability: "sharing.live",
      }),
      undefined,
    );
  }
});

const nativeOwner = {
  classification: "optional",
  capability: "connectors.external",
};
const backendPath = "/workspace/packages/app-core/src/lib/secret-backends/";

test.each([
  "onepassword-sdk.ts",
  "onepassword-sdk-loader.ts",
  "onepassword-sdk-codec.ts",
  "onepassword-sdk-write.ts",
  "onepassword-sdk.worker.ts",
  "onepassword-worker-http.ts",
  "onepassword-worker-protocol.js",
])("isolates native SDK source %s before the common backend leaf", (name) => {
  const file = `${backendPath}${name}`;
  for (const id of [
    file,
    file.replaceAll("/", "\\"),
    `${file}?worker_file&type=module`,
    `${file}#source`,
  ]) {
    assert.equal(
      secretBackendSdkChunk(id, nativeOwner),
      "secret-backend-onepassword-sdk",
    );
    assert.equal(
      lazyLeafChunk(id, nativeOwner),
      "secret-backend-onepassword-sdk",
    );
  }
});

test("native SDK isolation requires its optional connector owner", () => {
  const file = `${backendPath}onepassword-sdk.ts`;
  for (const entry of [
    { classification: "core", capability: "connectors.external" },
    { classification: "shared", capability: "connectors.external" },
    { classification: "optional", capability: "sharing.live" },
    { classification: "shared", capability: null },
  ]) {
    assert.equal(secretBackendSdkChunk(file, entry), undefined);
    assert.notEqual(
      lazyLeafChunk(file, entry),
      "secret-backend-onepassword-sdk",
    );
  }
});

test("Connect, common configuration and other SDKs keep the ordinary backend leaf", () => {
  for (const name of [
    "onepassword.ts",
    "factory.ts",
    "schema.ts",
    "types.ts",
    "presets.ts",
    "http.ts",
    "onepassword-artifacts.json",
    "bitwarden-sdk.ts",
    "bitwarden.worker.ts",
    "onepassword-sdking.ts",
  ]) {
    const file = `${backendPath}${name}`;
    assert.equal(secretBackendSdkChunk(file, nativeOwner), undefined);
    assert.equal(lazyLeafChunk(file, nativeOwner), "secret-backends");
  }
  const save = "/workspace/node_modules/@1password/save-button/dist/index.js";
  assert.equal(secretBackendSdkChunk(save, nativeOwner), undefined);
  assert.equal(lazyLeafChunk(save, nativeOwner), "vendor-1password-save");
});

test("virtual IDs, unrelated packages and query lookalikes cannot claim the native leaf", () => {
  for (const id of [
    `\0${backendPath}onepassword-sdk.ts`,
    `virtual:${backendPath}onepassword-sdk.ts`,
    "/workspace/packages/other/src/lib/secret-backends/onepassword-sdk.ts",
    `${backendPath}onepassword-sdk.test.ts`,
    `${backendPath}onepassword-sdk-loader.tsx`,
    `${backendPath}onepassword-sdk.ts/nested.js`,
    `${backendPath}onepassword.ts?${backendPath}onepassword-sdk.ts`,
  ]) {
    assert.equal(secretBackendSdkChunk(id, nativeOwner), undefined);
    assert.notEqual(
      lazyLeafChunk(id, nativeOwner),
      "secret-backend-onepassword-sdk",
    );
  }
});

test("a CommonJS wrapper is read as the file it wraps, and joins that file's leaf", () => {
  const pnpm = "/workspace/node_modules/.pnpm";
  const nkeys = `${pnpm}/@nats-io+nkeys@2.0.3/node_modules/@nats-io/nkeys/lib/mod.js`;
  const nacl = `${pnpm}/tweetnacl@1.0.3/node_modules/tweetnacl/nacl-fast.js`;
  const live = { classification: "optional", capability: "sharing.live" };
  for (const kind of ["exports", "module", "es-import", "proxy", "wrapped"]) {
    assert.equal(leafSource(`\0${nkeys}?commonjs-${kind}`), nkeys, kind);
    assert.equal(
      lazyLeafChunk(leafSource(`\0${nacl}?commonjs-${kind}`), live),
      "live-nats",
      kind,
    );
  }
  assert.equal(lazyLeafChunk(nkeys, live), "live-nats");
  assert.equal(lazyLeafChunk(nacl, live), "live-nats");
  assert.equal(leafSource(nacl), nacl, "a file is its own source");
  assert.equal(
    lazyLeafChunk(nacl, { classification: "shared", capability: null }),
    undefined,
    "the pin follows the capability's claim on the package",
  );
  for (const id of [
    "\0commonjsHelpers.js",
    "\0vite/preload-helper.js",
    `\0${nkeys}`,
    `\0${nkeys}?commonjs-unknown`,
  ])
    assert.equal(leafSource(id), undefined, JSON.stringify(id));
});

test("the CommonJS stand-ins two vendors share get one small chunk of their own", () => {
  for (const id of [
    "\0commonjs-dynamic-modules",
    "__vite-browser-external",
    "\0__vite-browser-external?commonjs-proxy",
  ])
    assert.equal(commonjsShimChunk(id), "commonjs-shims", JSON.stringify(id));
  for (const id of [
    "\0commonjsHelpers.js",
    "__vite-browser-external:crypto",
    "/workspace/node_modules/tweetnacl/nacl-fast.js",
  ])
    assert.equal(commonjsShimChunk(id), undefined, JSON.stringify(id));
});
