/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../../host.js";
import { pageOrigin } from "../../ports.js";
import { createTestHost } from "../../test-host.js";
import { readDeviceRows } from "../device-connector-records.js";
import { kvForgetAll } from "../kv.js";
import { vaultStore } from "../vault/store.js";
import { createSecretBackend } from "./factory.js";
import artifacts from "./onepassword-artifacts.json" with { type: "json" };
import * as loader from "./onepassword-sdk-loader.js";
import * as adapter from "./onepassword-sdk.js";
import { sdkFixture, vaultId } from "./onepassword-sdk.test-support.js";
import {
  secretBackendDraft,
  secretBackendModeLabel,
  secretBackendPreset,
} from "./presets.js";
import {
  saveSecretBackendConnection,
  secretBackendRuntimeSeams,
} from "./runtime.js";
import { runtimeFixture } from "./runtime.test-support.js";
import {
  publicSecretBackendDraft,
  validateSecretBackendDraft,
} from "./schema.js";
import {
  hydrateSecretBackendConnections,
  readSecretBackendConnection,
  secretBackendRuntimeConfiguration,
} from "./store.js";
import { bindSecretBackendTransport } from "./transport.js";
import type { SecretBackendDraft, SecretBackendFetch } from "./types.js";

let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
let unbind: (() => void) | undefined;
beforeEach(async () => {
  fixture = await runtimeFixture();
  unbind = undefined;
});
afterEach(async () => {
  unbind?.();
  await fixture.close();
});
function nativeDraft(
  changes: Partial<SecretBackendDraft> = {},
): SecretBackendDraft {
  return {
    ...secretBackendDraft("1password"),
    name: "Native mode fixture",
    baseUrl: "https://account.1password.invalid",
    token: "native-mode-custody-fixture-token",
    vaultId,
    ...changes,
  };
}

it("defaults new 1Password drafts to native and exposes the same native method through BYO", () => {
  expect(secretBackendDraft("1password").mode).toBe("onepassword-sdk");
  expect(secretBackendPreset("1password")?.modes).toEqual([
    "onepassword-sdk",
    "onepassword-connect",
    "file-import",
  ]);
  expect(secretBackendPreset("byo-secret-backend")?.modes).toContain(
    "onepassword-sdk",
  );
  expect(secretBackendDraft("byo-secret-backend").mode).toBe("local");
  expect(secretBackendModeLabel("onepassword-sdk")).toBe(
    "1Password native SDK",
  );
  expect(
    validateSecretBackendDraft(
      nativeDraft({ providerId: "byo-secret-backend" }),
    ).mode,
  ).toBe("onepassword-sdk");
});

it.each([
  { token: "" },
  { token: " " },
  { token: "x".repeat(16_385) },
  { token: "private\nvalue" },
  { token: `private${String.fromCharCode(0)}value` },
  { vaultId: "" },
  { vaultId: " " },
  { vaultId: "x".repeat(1025) },
  { baseUrl: "https://account.invalid/api" },
  { baseUrl: "http://remote.invalid" },
  { baseUrl: "https://private-user:private-password@account.invalid" },
  { baseUrl: "https://account.invalid/?private-query" },
  { baseUrl: "https://account.invalid/#private-fragment" },
  { providerId: "bitwarden" },
])(
  "rejects invalid native configuration before any SDK or HTTP use %#",
  (change) => {
    expect(() => validateSecretBackendDraft(nativeDraft(change))).toThrow();
    expect(fixture.fetcher).not.toHaveBeenCalled();
  },
);

it("keeps native boundary lengths, loopback policy and public blank edits compatible", () => {
  expect(
    validateSecretBackendDraft(
      nativeDraft({ token: "x".repeat(16_384), vaultId: "v".repeat(1024) }),
    ).token,
  ).toHaveLength(16_384);
  expect(
    validateSecretBackendDraft(
      nativeDraft({ baseUrl: "http://localhost:5180" }),
    ).baseUrl,
  ).toBe("http://localhost:5180");
  const displayed = publicSecretBackendDraft(nativeDraft());
  expect(displayed.token).toBe("");
  expect(validateSecretBackendDraft(displayed, false)).toEqual(displayed);
  expect(() => validateSecretBackendDraft(displayed)).toThrow();
});

it("saves and cold-reloads a native token through actual encrypted-vault custody without constructing its SDK", async () => {
  const create = vi.spyOn(secretBackendRuntimeSeams, "createBackend");
  const client = vi.spyOn(loader, "createBrowserOnePasswordClient");
  const assets = vi.spyOn(loader, "onePasswordBrowserAssets");
  const draft = nativeDraft();
  const saved = await saveSecretBackendConnection(draft);
  expect(saved.status).toBe("pending");
  expect(vaultStore.getSnapshot().items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "credential",
        method: expect.objectContaining({ type: "token", token: draft.token }),
      }),
    ]),
  );
  expect(JSON.stringify(readDeviceRows())).not.toContain(draft.token);
  expect(
    [...fixture.files.values()].some((value) => value.includes(draft.token)),
  ).toBe(false);
  kvForgetAll();
  await hydrateSecretBackendConnections();
  const displayed = readSecretBackendConnection(saved.connectionId);
  expect(displayed).toMatchObject({ mode: "onepassword-sdk", token: "" });
  if (!displayed) throw new Error("Expected saved native metadata");
  await saveSecretBackendConnection(
    { ...displayed, name: "Renamed native fixture" },
    saved.connectionId,
  );
  expect(
    secretBackendRuntimeConfiguration(
      saved.connectionId,
      vaultStore.getSnapshot().tomb,
    )?.token,
  ).toBe(draft.token);
  expect(create).not.toHaveBeenCalled();
  expect(client).not.toHaveBeenCalled();
  expect(assets).not.toHaveBeenCalled();
  expect(fixture.fetcher).not.toHaveBeenCalled();
});

it("never borrows a blank native token after changing account, vault or protocol", async () => {
  const saved = await saveSecretBackendConnection(nativeDraft());
  const displayed = readSecretBackendConnection(saved.connectionId);
  if (!displayed) throw new Error("Expected saved native metadata");
  for (const change of [
    { baseUrl: "https://other.1password.invalid" },
    { vaultId: "other-vault" },
    { mode: "onepassword-connect" as const },
  ]) {
    await expect(
      saveSecretBackendConnection(
        { ...displayed, ...change },
        saved.connectionId,
      ),
    ).rejects.toMatchObject({ code: "configuration" });
  }
  expect(
    secretBackendRuntimeConfiguration(
      saved.connectionId,
      vaultStore.getSnapshot().tomb,
    )?.token,
  ).toBe(nativeDraft().token);
  expect(fixture.fetcher).not.toHaveBeenCalled();
});

it.each(["onepassword-connect", "file-import"] as const)(
  "keeps an existing saved %s connection unchanged after the native default",
  async (mode) => {
    const draft = nativeDraft({
      mode,
      token: mode === "file-import" ? "" : "connect-token-fixture",
    });
    const saved = await saveSecretBackendConnection(draft);
    kvForgetAll();
    await hydrateSecretBackendConnections();
    expect(readSecretBackendConnection(saved.connectionId)?.mode).toBe(mode);
    expect(readSecretBackendConnection(saved.connectionId)?.token).toBe("");
    expect(fixture.fetcher).not.toHaveBeenCalled();
  },
);

it("constructs the real native adapter lazily with host-owned compressed asset URLs", async () => {
  configureHost(createTestHost({ env: { BASE_URL: "/operator/pwa/" } }));
  const client = vi.spyOn(loader, "createBrowserOnePasswordClient");
  const backend = await createSecretBackend("onepassword-sdk");
  expect(backend.id).toBe("onepassword-sdk");
  expect(backend.capabilities).toMatchObject({
    list: true,
    get: true,
    create: true,
    update: true,
    delete: true,
    import: false,
  });
  expect(client).not.toHaveBeenCalled();
  expect(fixture.fetcher).not.toHaveBeenCalled();
  expect(loader.onePasswordBrowserAssets()).toEqual({
    origin: pageOrigin(),
    runtimeUrl: `${pageOrigin()}/operator/pwa/${artifacts.assets.runtime}`,
    wasmUrl: `${pageOrigin()}/operator/pwa/${artifacts.assets.wasm}`,
  });
});

it.each([
  "inactive",
  "already-ended",
  "during-import",
  "during-descriptor",
] as const)(
  "refuses native construction when authority ends %s",
  async (timing) => {
    const construct = vi.spyOn(adapter, "createOnePasswordSdkBackend");
    const owner = new AbortController();
    if (timing === "inactive") {
      const release = bindSecretBackendTransport({
        fetch: fixture.fetcher,
        assertCurrent() {},
        signal: owner.signal,
      });
      release();
    }
    if (timing === "already-ended") owner.abort();
    if (timing === "during-descriptor") {
      const assets = loader.onePasswordBrowserAssets;
      vi.spyOn(loader, "onePasswordBrowserAssets").mockImplementation(() => {
        const result = assets();
        owner.abort();
        return result;
      });
    }
    const pending = createSecretBackend(
      "onepassword-sdk",
      undefined,
      owner.signal,
    );
    if (timing === "during-import") owner.abort();
    await expect(pending).rejects.toMatchObject({ code: "stale" });
    expect(construct).not.toHaveBeenCalled();
    expect(fixture.fetcher).not.toHaveBeenCalled();
  },
);

// Controlled native replies test factory composition; they do not prove SDK cryptography or hosted login.
it("uses the default loader binding and the original captured HTTP/owner lifetime after rebinding", async () => {
  const f = sdkFixture();
  const client = vi
    .spyOn(loader, "createBrowserOnePasswordClient")
    .mockResolvedValue(f.client);
  const feature = new AbortController();
  const owner = new AbortController();
  const first = vi.fn<SecretBackendFetch>(
    async () => new Response(null, { status: 204 }),
  );
  const oldRelease = bindSecretBackendTransport({
    fetch: first,
    assertCurrent() {},
    signal: feature.signal,
  });
  const pending = createSecretBackend(
    "onepassword-sdk",
    undefined,
    owner.signal,
  );
  const next = vi.fn<SecretBackendFetch>();
  unbind = bindSecretBackendTransport({
    fetch: next,
    assertCurrent() {},
    signal: new AbortController().signal,
  });
  oldRelease();
  const backend = await pending;
  const session = await backend.authenticate(nativeDraft());
  const call = client.mock.calls[0];
  expect(call?.[0]).toEqual({
    accountOrigin: nativeDraft().baseUrl,
    serviceAccountToken: nativeDraft().token,
    vaultId,
  });
  expect(call?.[1]).toEqual(loader.onePasswordBrowserAssets());
  expect(call?.[2].signal).toBe(backend.signal);
  expect(call?.[3]).toBe(backend.signal);
  await call?.[2].fetch(`${nativeDraft().baseUrl}/owned-fixture`);
  expect(first).toHaveBeenCalledOnce();
  expect(next).not.toHaveBeenCalled();
  owner.abort();
  expect(backend.signal?.aborted).toBe(true);
  await expect(backend.listItems(session)).rejects.toMatchObject({
    code: "stale",
  });
  await backend.disconnect(session);
  expect(f.dispose).toHaveBeenCalledOnce();
});
