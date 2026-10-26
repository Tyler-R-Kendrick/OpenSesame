import assert from "node:assert/strict";
import { test } from "vitest";
import { LIB_RULES } from "../../src/lib/capabilities/classification-lib.js";
import { PACKAGE_RULES } from "../../src/lib/capabilities/classification-packages.js";
import { classifyModule } from "./capability-graph.mjs";
import {
  lazyLeafChunk,
  secretBackendSdkChunk,
} from "./capability-lazy-leaves.mjs";

test("keeps the NATS signer with its carrier instead of connector metadata", () => {
  const file =
    "/repo/node_modules/.pnpm/tweetnacl@1.0.3/node_modules/tweetnacl/nacl-fast.js";
  const owner = classifyModule(file, PACKAGE_RULES, { repoRoot: "/repo" });
  assert.equal(owner.classification, "optional");
  assert.equal(owner.capability, "sharing.live");
  assert.equal(lazyLeafChunk(file, owner), "live-nats");
  assert.equal(lazyLeafChunk(file.replaceAll("/", "\\"), owner), "live-nats");
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
    lazyLeafChunk("/repo/node_modules/tweetnacl-extra/index.js", owner),
    undefined,
  );
});

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

test("the browser credential adapter stays with its actual backend owner", () => {
  const file =
    "/workspace/packages/app-core/src/browser/secret-backend-credentials.ts";
  const entry = classifyModule(file, LIB_RULES, { repoRoot: "/workspace" });
  assert.equal(entry.classification, "optional");
  assert.equal(entry.capability, "connectors.external");
  assert.equal(lazyLeafChunk(file, entry), "secret-backends");
  assert.equal(
    lazyLeafChunk(file.replaceAll("/", "\\"), entry),
    "secret-backends",
  );
  assert.equal(
    lazyLeafChunk(file, { classification: "shared", capability: null }),
    undefined,
  );
  assert.equal(
    lazyLeafChunk(file, {
      classification: "optional",
      capability: "sharing.live",
    }),
    undefined,
  );
  const neighbor =
    "/workspace/packages/app-core/src/browser/kdbx-native-dom.ts";
  assert.equal(
    lazyLeafChunk(
      neighbor,
      classifyModule(neighbor, LIB_RULES, { repoRoot: "/workspace" }),
    ),
    undefined,
  );
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

// Actual owner, not a test-only reclassification of the pure organization model.
test("keeps the directory sign-in model off the bootstrap without promoting its owner", () => {
  const file = "/workspace/packages/app-core/src/lib/org-signin.ts";
  const entry = classifyModule(file, LIB_RULES, { repoRoot: "/workspace" });
  assert.equal(entry.classification, "optional");
  assert.equal(entry.capability, "enterprise.directory-provisioning");
  for (const id of [file, file.replaceAll("/", "\\")])
    assert.equal(lazyLeafChunk(id, entry), "directory-signin-model");
  for (const owner of [
    { classification: "shared", capability: null },
    { classification: "core", capability: null },
    { classification: "optional", capability: "connectors.external" },
  ])
    assert.equal(lazyLeafChunk(file, owner), undefined);
  for (const name of [
    "org-signin.test.ts",
    "org-signin-other.ts",
    "identity-enterprise.ts",
  ])
    assert.equal(
      lazyLeafChunk(file.replace("org-signin.ts", name), entry),
      undefined,
    );
});

test("keeps the real NKeys signer with NATS without claiming virtual wrappers or connector credentials", () => {
  const root = "/workspace";
  const source = `${root}/node_modules/.pnpm/tweetnacl@1.0.3/node_modules/tweetnacl/nacl-fast.js`;
  const entry = classifyModule(source, PACKAGE_RULES, { repoRoot: root });
  assert.equal(entry.classification, "optional");
  assert.equal(entry.capability, "sharing.live");
  for (const id of [
    source,
    source.replaceAll("/", "\\"),
    `${root}/node_modules/tweetnacl/nacl-fast.js`,
  ])
    assert.equal(lazyLeafChunk(id, entry), "live-nats");
  const wrapper = `\0${source}?commonjs-module`;
  const wrapperEntry = classifyModule(wrapper, PACKAGE_RULES, {
    repoRoot: root,
  });
  assert.equal(wrapperEntry.rationale, "virtual");
  assert.equal(lazyLeafChunk(wrapper, wrapperEntry), undefined);
  for (const owner of [
    { classification: "shared", capability: null },
    { classification: "core", capability: null },
    { classification: "optional", capability: "connectors.external" },
  ])
    assert.equal(lazyLeafChunk(source, owner), undefined);
  const credentials = `${root}/packages/app-core/src/browser/secret-backend-credentials.ts`;
  const credentialOwner = classifyModule(credentials, LIB_RULES, {
    repoRoot: root,
  });
  assert.equal(credentialOwner.classification, "optional");
  assert.equal(credentialOwner.capability, "connectors.external");
  assert.equal(lazyLeafChunk(credentials, credentialOwner), undefined);
  assert.equal(
    lazyLeafChunk(source.replace("/tweetnacl/", "/tweetnacl-extra/"), entry),
    undefined,
  );
});
