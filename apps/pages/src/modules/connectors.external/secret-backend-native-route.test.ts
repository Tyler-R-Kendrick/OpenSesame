import { createSecretBackend } from "@opensesame/app-core/lib/secret-backends/factory.js";
import { secretBackendDraft } from "@opensesame/app-core/lib/secret-backends/presets.js";
import { runtimeFixture } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import {
  type TailscaleBrowserNode,
  TailscaleNativeHTTPConfiguration,
  bindTailscaleBrowserNode,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import {
  openBrowserNodeState,
  updateBrowserNodeNativeHTTP,
} from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindSecretBackendRuntime } from "./secret-backend-runtime.js";
let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
const releases: (() => void)[] = [];
beforeEach(async () => {
  fixture = await runtimeFixture();
});
afterEach(async () => {
  for (const release of releases.splice(0).reverse()) release();
  await fixture.close();
});
const config = {
  hostname: "original-browser",
  controlURL: "https://controlplane.tailscale.com",
  nativeHTTP: TailscaleNativeHTTPConfiguration.parse({
    version: 1,
    exitNodeID: "approved-exit",
    trustMode: "public",
    targets: [
      { origin: "https://api.example.com", prefixes: ["203.0.113.0/24"] },
    ],
  }),
};
async function save() {
  return openBrowserNodeState(
    structuredClone(config),
    vaultStore.getSnapshot().tomb,
    () => {
      if (vaultStore.getSnapshot().status !== "unlocked")
        throw new Error("locked");
    },
  );
}
function node() {
  const lifetime = new AbortController();
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    lifetime.signal.throwIfAborted();
    init?.signal?.throwIfAborted();
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    const secret = {
      secretKey: "SHARED",
      secretValue: "native-value",
      secretComment: "native-note",
    };
    return Response.json(
      url.pathname.endsWith("/SHARED") ? { secret } : { secrets: [secret] },
    );
  });
  const capture = vi.fn(() => ({
    fetch,
    signal: lifetime.signal,
    assertCurrent: () => lifetime.signal.throwIfAborted(),
  }));
  const value: TailscaleBrowserNode = {
    captureNativeHTTP: capture,
    snapshot: () => ({
      status: "connected",
      hostname: config.hostname,
      controlURL: config.controlURL,
      authURL: "",
      addresses: ["100.64.0.3"],
      peerCount: 1,
      failure: "",
    }),
    subscribe: () => () => {},
    start: async () => {},
    stop: () => lifetime.abort(),
    forget: async () => {},
    login() {},
    get: async () => {
      throw new Error("No peer GET double");
    },
  };
  releases.push(bindTailscaleBrowserNode(value));
  return { fetch, capture, lifetime };
}
function activate() {
  const context = createTestContext();
  const activation = createActivation(context.ctx, "connectors.external");
  bindSecretBackendRuntime(context.ctx, activation);
  releases.push(activation.dispose);
  return context;
}
const configuration = () => ({
  ...secretBackendDraft("infisical"),
  baseUrl: "https://api.example.com",
  token: "private-scoped-token",
  projectId: "project",
  environment: "dev",
  secretPath: "/",
});
it("the actual common factory authenticates, lists and reads Infisical notes through one captured original native port", async () => {
  await save();
  const n = node();
  const context = activate();
  const originalFetch = globalThis.fetch;
  const backend = await createSecretBackend("infisical");
  const session = await backend.authenticate(configuration());
  expect(await backend.listItems(session)).toEqual([
    { id: "SHARED", name: "SHARED", kind: "secret" },
  ]);
  expect(await backend.getNotes("SHARED", session)).toBe("native-note");
  expect(n.capture).toHaveBeenCalledTimes(1);
  expect(n.fetch).toHaveBeenCalledTimes(3);
  expect(context.egressCalls).toEqual([]);
  expect(globalThis.fetch).toBe(originalFetch);
  for (const [request] of n.fetch.mock.calls) {
    expect(request).toBeInstanceOf(Request);
    if (request instanceof Request)
      expect(request.headers.get("authorization")).toBe(
        "Bearer private-scoped-token",
      );
  }
  await backend.disconnect(session);
});
it("a backend captured before its original native node exists never borrows a later node or falls back to browser egress", async () => {
  await save();
  const context = activate();
  const backend = await createSecretBackend("infisical");
  const later = node();
  await expect(backend.authenticate(configuration())).rejects.toThrow();
  expect(later.capture).not.toHaveBeenCalled();
  expect(later.fetch).not.toHaveBeenCalled();
  expect(context.egressCalls).toEqual([]);
});
it.each(["node", "retarget", "lease", "owner"])(
  "the captured factory session refuses %s withdrawal before another credential-bearing operation",
  async (reason) => {
    const stored = await save();
    const n = node();
    const context = activate();
    const owner = new AbortController();
    const backend = await createSecretBackend(
      "infisical",
      undefined,
      owner.signal,
    );
    const session = await backend.authenticate(configuration());
    if (reason === "node") n.lifetime.abort();
    else if (reason === "retarget")
      await updateBrowserNodeNativeHTTP(
        stored.record,
        {
          ...config.nativeHTTP,
          targets: [
            {
              origin: "https://api.example.com",
              prefixes: ["198.51.100.0/24"],
            },
          ],
        },
        () => {
          if (vaultStore.getSnapshot().status !== "unlocked")
            throw new Error("locked");
        },
      );
    else if (reason === "lease") context.abort();
    else owner.abort();
    await expect(backend.getNotes("SHARED", session)).rejects.toThrow();
    expect(n.fetch).toHaveBeenCalledTimes(1);
    expect(n.capture).toHaveBeenCalledTimes(1);
    expect(context.egressCalls).toEqual([]);
    await backend.disconnect(session);
  },
);
