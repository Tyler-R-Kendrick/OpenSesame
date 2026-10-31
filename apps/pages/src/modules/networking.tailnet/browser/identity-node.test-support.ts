/** @vitest-environment node */
// Real Node Worker + verified HTTPS at the existing SDK boundary; not Go/WASM enrollment.
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tlsOracle } from "@opensesame/app-core/browser/oidc/tls.test-support.js";
import {
  TAILSCALE_BROWSER_NODE_PURPOSE,
  TAILSCALE_IDENTITY_HTTP_PURPOSE,
} from "@opensesame/app-core/lib/capabilities/catalog-optional-services.js";
import {
  CAPABILITY_CATALOG,
  describeCapability,
} from "@opensesame/app-core/lib/capabilities/catalog.js";
import { createEgressPort } from "@opensesame/app-core/lib/capabilities/egress.js";
import {
  type IdentityBrowserNodeConfiguration,
  bindIdentityBrowserNodeFactory,
  captureIdentityBrowserNode,
} from "@opensesame/app-core/lib/tailscale/browser-node-identity-port.js";
import { TailscaleNativeHTTPConfiguration } from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import {
  buildConsentReceipt,
  fixtureResolveInput,
  fixtureSelection,
  resolveComposition,
} from "@opensesame/capability-composition";
import { afterAll, afterEach, beforeAll, expect, vi } from "vitest";
import { MemoryIdentityBrowserNode } from "./identity-browser-node.js";
import { threadWorker } from "./identity-worker.test-support.js";

let bundle = process.env.NATIVE_IDENTITY_TEST_WORKER_BUNDLE ?? "";
let temporary = "";
const close: (() => Promise<void>)[] = [];
beforeAll(async () => {
  if (bundle) return;
  temporary = await mkdtemp(join(tmpdir(), "native-identity-worker-"));
  bundle = join(temporary, "worker.mjs");
  const { build } = createRequire(
    new URL(
      "../../../../../../packages/app-core/package.json",
      import.meta.url,
    ),
  )("esbuild");
  await build({
    entryPoints: [
      fileURLToPath(
        new URL("./identity-worker.test-support.ts", import.meta.url),
      ),
    ],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
});
afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});
afterEach(async () => {
  for (const end of close.splice(0).reverse()) await end();
  vi.restoreAllMocks();
});
function plan() {
  const input = fixtureResolveInput({
    catalog: CAPABILITY_CATALOG,
    installation: fixtureSelection({
      selectedOptional: ["networking.tailnet"],
    }),
  });
  const base = {
    ...input,
    distribution: {
      ...input.distribution,
      capabilityIds: CAPABILITY_CATALOG.capabilities.map((item) => item.id),
      moduleIds: CAPABILITY_CATALOG.capabilities.flatMap(
        (item) => item.moduleIds,
      ),
    },
  };
  const first = resolveComposition(base);
  const receipt = buildConsentReceipt(
    first,
    CAPABILITY_CATALOG,
    input.facts.now,
  );
  return resolveComposition({ ...base, receipt });
}
function networkPolicy(origins: string[]) {
  const descriptor = describeCapability("networking.tailnet");
  if (!descriptor) throw new Error("Original Networking descriptor missing.");
  let approved: import("@opensesame/capability-composition").EffectivePlan = {
    ...plan(),
    network: {
      externalServices: "allow" as const,
      allowedServiceOrigins: [...origins, "https://control.example.test"],
    },
  };
  const browserFetch = vi.fn<typeof fetch>(() => {
    throw new Error("Browser fetch bypass");
  });
  const policy = createEgressPort({
    capability: descriptor,
    plan: () => approved,
    allowedOrigins: ["https://pwa.example.test"],
    mayPairLocalAuthority: () => true,
    fetchImpl: browserFetch,
  });
  return {
    descriptor,
    policy,
    browserFetch,
    withdrawPolicy() {
      approved = {
        ...approved,
        network: { ...approved.network, externalServices: "deny" },
      };
    },
  };
}
export async function identityNodeFixture() {
  const idp = await tlsOracle("client_secret_basic", "both");
  const origins = [
    ...new Set(
      [idp.config.issuer, idp.tokenBase, idp.jwksBase].map(
        (value) => new URL(value).origin,
      ),
    ),
  ];
  const { descriptor, policy, browserFetch, withdrawPolicy } =
    networkPolicy(origins);
  const owner = new AbortController();
  const original = {
    signal: owner.signal,
    assertCurrent: () => owner.signal.throwIfAborted(),
  };
  const thread = threadWorker(bundle);
  const release = bindIdentityBrowserNodeFactory(
    (captured) =>
      new MemoryIdentityBrowserNode(
        captured,
        {
          assertCurrent: original.assertCurrent,
          approve: (url) =>
            policy.decide(url, {
              capability: descriptor.id,
              purpose: TAILSCALE_BROWSER_NODE_PURPOSE,
            }).ok,
          approvePeer: () => false,
          approveNative: (url) =>
            policy.decide(url, {
              capability: descriptor.id,
              purpose: TAILSCALE_IDENTITY_HTTP_PURPOSE,
            }).ok,
        },
        {
          runtime: "https://pwa.example.test/runtime.js",
          wasm: "https://pwa.example.test/node.gz",
          nativeHTTP: "https://pwa.example.test/native.js",
        },
        () => thread.facade,
      ),
  );
  const node = captureIdentityBrowserNode(original);
  if (!node) throw new Error("Original identity Worker factory missing.");
  close.push(async () => {
    release();
    await node.stop();
    await thread.exit;
  });
  const configuration = {
    controlURL: "https://control.example.test",
    nativeHTTP: TailscaleNativeHTTPConfiguration.parse({
      version: 1,
      exitNodeID: "original-approved-exit",
      trustMode: "operator",
      operatorCAPEM: idp.operatorCA,
      targets: origins.map((origin) => ({ origin, prefixes: ["127.0.0.0/8"] })),
    }),
  };
  const connect = async (
    selected: IdentityBrowserNodeConfiguration = configuration,
  ) => {
    node.start(selected);
    await vi.waitFor(() => expect(node.snapshot().status).toBe("login"));
    expect(thread.diagnostics).toContainEqual({
      fixture: "memory",
      noAuthKey: true,
      emptyState: true,
      localState: true,
    });
    expect(
      thread.diagnostics.some((entry) => entry.fixture === "explicit-login"),
    ).toBe(false);
    node.login();
    await vi.waitFor(() => expect(node.snapshot().status).toBe("connected"));
  };
  return {
    idp,
    owner,
    original,
    node,
    thread,
    browserFetch,
    configuration,
    connect,
    withdrawPolicy,
  };
}
