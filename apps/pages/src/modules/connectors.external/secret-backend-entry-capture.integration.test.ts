import { kvForgetAll } from "@opensesame/app-core/lib/kv.js";
import { createSecretBackend } from "@opensesame/app-core/lib/secret-backends/factory.js";
import { secretBackendDraft } from "@opensesame/app-core/lib/secret-backends/presets.js";
import { secretBackendVaultGuard } from "@opensesame/app-core/lib/secret-backends/runtime-guard.js";
import {
  connectSecretBackend,
  probeSecretBackend,
  saveSecretBackendConnection,
  secretBackendRuntimeSeams,
} from "@opensesame/app-core/lib/secret-backends/runtime.js";
import {
  deferred,
  ledgerFile,
} from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import * as store from "@opensesame/app-core/lib/secret-backends/store.js";
import {
  bindSecretBackendTransport,
  captureSecretBackendTransport,
} from "@opensesame/app-core/lib/secret-backends/transport.js";
import {
  bindTailscaleBrowserNode,
  tailscaleBrowserNode,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  primaryKey,
  primaryOracle,
} from "../../sections/connections/connect/native-api-primary.test-support.js";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindSecretBackendRuntime } from "./secret-backend-runtime.js";

const contract = {
  id: "1password",
  name: "Connect",
  origin: "https://connect.example.com",
  authorization: `Bearer ${primaryKey}`,
  parameters: {},
  verifyPath: "/v1/vaults/vault",
  readPath: "/v1/vaults/vault/items",
  verifyReply: { id: "vault" },
  reply: [],
  action: "",
  operation: "",
  resultLabel: "",
};
let fixture: Awaited<ReturnType<typeof primaryOracle>>;
const releases: (() => void)[] = [];
beforeEach(async () => {
  fixture = await primaryOracle(contract);
  bindSecretBackendRuntime(fixture.context.ctx, fixture.activation);
});
afterEach(async () => {
  for (const release of releases.splice(0).reverse()) release();
  await fixture.close();
});
function configuration() {
  return {
    ...secretBackendDraft("1password"),
    mode: "onepassword-connect" as const,
    baseUrl: contract.origin,
    token: primaryKey,
    vaultId: "vault",
  };
}
function gateHydration() {
  const entered = deferred<void>();
  const resumed = deferred<void>();
  const hydrate = store.hydrateSecretBackendConnections;
  vi.spyOn(store, "hydrateSecretBackendConnections").mockImplementationOnce(
    async () => {
      entered.resolve();
      await resumed.promise;
      await hydrate();
    },
  );
  return { entered: entered.promise, release: () => resumed.resolve() };
}
function activateReplacement() {
  const context = createTestContext();
  const activation = createActivation(context.ctx, "connectors.external");
  bindSecretBackendRuntime(context.ctx, activation);
  releases.push(activation.dispose);
  return context;
}
function originalNode() {
  const original = tailscaleBrowserNode();
  if (!original?.captureNativeHTTP) throw new Error("Original node missing");
  return original;
}

it("captures the actual vault session before the first microtask and never adopts its later lock", async () => {
  const pending = secretBackendVaultGuard();
  vaultStore.lock();
  const guard = await pending;
  expect(guard.current()).toBe(false);
  expect(guard.signal.aborted).toBe(true);
  guard.close();
  expect(fixture.requests).toEqual([]);
});

it("cold sealed configuration resolves under the original route and lists through verified TLS", async () => {
  const saved = await saveSecretBackendConnection(configuration());
  expect(fixture.storage.files.get(ledgerFile)).not.toContain(primaryKey);
  const hydrate = store.hydrateSecretBackendConnections;
  vi.spyOn(store, "hydrateSecretBackendConnections").mockImplementationOnce(
    async () => {
      kvForgetAll();
      expect(store.readSecretBackendConnection(saved.connectionId)).toBeNull();
      await hydrate();
    },
  );
  const capture = vi.spyOn(originalNode(), "captureNativeHTTP");
  const handle = await connectSecretBackend(saved.connectionId);
  expect(await handle.backend.listItems(handle.session)).toEqual([]);
  expect(store.readSecretBackendConnection(saved.connectionId)?.token).toBe("");
  expect(capture).toHaveBeenCalledOnce();
  expect(fixture.requests).toEqual([
    { authorized: true, path: contract.verifyPath, emptyBody: true },
    { authorized: true, path: contract.readPath, emptyBody: true },
  ]);
  expect(fixture.browser).not.toHaveBeenCalled();
  expect(fixture.context.egressCalls).toEqual([]);
  await handle.backend.disconnect(handle.session);
});

it.each(["connect", "probe"] as const)(
  "%s captures before hydration and refuses a replacement activation without sending credentials",
  async (action) => {
    const saved = await saveSecretBackendConnection(configuration());
    const capture = vi.spyOn(originalNode(), "captureNativeHTTP");
    const gate = gateHydration();
    const pending =
      action === "connect"
        ? connectSecretBackend(saved.connectionId)
        : probeSecretBackend(
            store.readSecretBackendConnection(saved.connectionId) ??
              configuration(),
            saved.connectionId,
          );
    const refused = expect(pending).rejects.toMatchObject({ code: "stale" });
    await gate.entered;
    const before = capture.mock.calls.length;
    fixture.activation.dispose();
    const replacement = activateReplacement();
    gate.release();
    await refused;
    expect(before).toBe(1);
    expect(capture).toHaveBeenCalledOnce();
    expect(fixture.requests).toEqual([]);
    expect(replacement.egressCalls).toEqual([]);
    expect(fixture.browser).not.toHaveBeenCalled();
  },
);

it("a node unavailable at action entry cannot be adopted after saved-configuration hydration", async () => {
  const original = originalNode();
  const clear = bindTailscaleBrowserNode({ ...original, stop() {} });
  clear();
  const capture = vi.spyOn(original, "captureNativeHTTP");
  const saved = await saveSecretBackendConnection(configuration());
  const gate = gateHydration();
  const pending = connectSecretBackend(saved.connectionId);
  const refused = expect(pending).rejects.toThrow();
  await gate.entered;
  releases.push(bindTailscaleBrowserNode({ ...original, stop() {} }));
  gate.release();
  await refused;
  expect(capture).not.toHaveBeenCalled();
  expect(fixture.requests).toEqual([]);
  expect(fixture.context.egressCalls).toEqual([]);
});

it("an unavailable External activation cannot be adopted after hydration", async () => {
  const saved = await saveSecretBackendConnection(configuration());
  fixture.activation.dispose();
  const gate = gateHydration();
  const pending = connectSecretBackend(saved.connectionId);
  const refused = expect(pending).rejects.toMatchObject({ code: "stale" });
  await gate.entered;
  const replacement = activateReplacement();
  gate.release();
  await refused;
  expect(fixture.requests).toEqual([]);
  expect(replacement.egressCalls).toEqual([]);
});

it("reconnection captures before waiting for original session disposal", async () => {
  const saved = await saveSecretBackendConnection(configuration());
  const gate = deferred<void>();
  const entered = deferred<void>();
  const construct = secretBackendRuntimeSeams.createBackend;
  vi.spyOn(secretBackendRuntimeSeams, "createBackend").mockImplementation(
    async (...args) => {
      const backend = await construct(...args);
      const dispose = backend.disconnect.bind(backend);
      vi.spyOn(backend, "disconnect").mockImplementationOnce(
        async (session) => {
          entered.resolve();
          await gate.promise;
          await dispose(session);
        },
      );
      return backend;
    },
  );
  const capture = vi.spyOn(originalNode(), "captureNativeHTTP");
  await connectSecretBackend(saved.connectionId);
  const pending = connectSecretBackend(saved.connectionId);
  const refused = expect(pending).rejects.toMatchObject({ code: "stale" });
  await entered.promise;
  const before = capture.mock.calls.length;
  fixture.context.abort();
  const replacement = activateReplacement();
  gate.resolve();
  await refused;
  expect(before).toBe(2);
  expect(capture).toHaveBeenCalledTimes(2);
  expect(fixture.requests).toHaveLength(1);
  expect(replacement.egressCalls).toEqual([]);
});

it("the captured caller drains a held TLS response while another original session continues", async () => {
  const caller = new AbortController();
  const first = await connectSecretBackend(
    configuration(),
    undefined,
    caller.signal,
  );
  const independent = await connectSecretBackend(configuration());
  const held = fixture.hold();
  const pending = first.backend.listItems(first.session);
  const refused = expect(pending).rejects.toMatchObject({ code: "stale" });
  await held.arrived;
  caller.abort();
  await refused;
  await held.closed;
  expect(fixture.lifetime.signal.aborted).toBe(false);
  fixture.reply([]);
  expect(await independent.backend.listItems(independent.session)).toEqual([]);
  await independent.backend.disconnect(independent.session);
  expect(fixture.browser).not.toHaveBeenCalled();
});

it.each(["connect", "probe"] as const)(
  "pre-aborted %s does not capture a node, hydrate custody or send a request",
  async (action) => {
    const capture = vi.spyOn(originalNode(), "captureNativeHTTP");
    const hydrate = vi.spyOn(store, "hydrateSecretBackendConnections");
    const ended = AbortSignal.abort();
    const pending =
      action === "connect"
        ? connectSecretBackend(configuration(), undefined, ended)
        : probeSecretBackend(configuration(), undefined, ended);
    await expect(pending).rejects.toMatchObject({ code: "stale" });
    expect(capture).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
    expect(fixture.requests).toEqual([]);
  },
);

it.each([
  "encrypted-remote",
  "proton-pass",
  "onepassword-sdk",
  "onepassword-connect",
  "bitwarden-api",
  "bitwarden-secrets",
  "infisical",
  "passwordstate",
] as const)(
  "%s cannot replace an explicitly unavailable original carrier",
  async (mode) => {
    fixture.activation.dispose();
    const original = captureSecretBackendTransport();
    const replacement = activateReplacement();
    const capture = vi.spyOn(originalNode(), "captureNativeHTTP");
    await expect(
      createSecretBackend(mode, undefined, undefined, undefined, original),
    ).rejects.toMatchObject({ code: "stale" });
    expect(capture).not.toHaveBeenCalled();
    expect(fixture.requests).toEqual([]);
    expect(replacement.egressCalls).toEqual([]);
  },
);

it.each(["local", "file-import", "credential-management"] as const)(
  "%s stays constructible without External authority",
  async (mode) => {
    fixture.activation.dispose();
    const original = captureSecretBackendTransport();
    const backend = await createSecretBackend(
      mode,
      undefined,
      undefined,
      undefined,
      original,
    );
    expect(backend.id).toBe(mode);
    expect(fixture.requests).toEqual([]);
  },
);

it("the local vault runtime remains usable without External authority", async () => {
  fixture.activation.dispose();
  const handle = await connectSecretBackend(secretBackendDraft("local-vault"));
  expect(await handle.backend.listItems(handle.session)).toBeInstanceOf(Array);
  await handle.backend.disconnect(handle.session);
  expect(fixture.requests).toEqual([]);
});

it("the immutable captured methods cannot be swapped while configuration hydration waits", async () => {
  const lifetime = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>(fixture.fetch);
  const owner = { fetch, assertCurrent() {}, signal: lifetime.signal };
  releases.push(bindSecretBackendTransport(owner));
  const gate = gateHydration();
  const pending = connectSecretBackend(configuration());
  await gate.entered;
  const substituted = vi.fn<typeof globalThis.fetch>();
  owner.fetch = substituted;
  gate.release();
  const handle = await pending;
  expect(fetch).toHaveBeenCalledOnce();
  expect(substituted).not.toHaveBeenCalled();
  await handle.backend.disconnect(handle.session);
});
