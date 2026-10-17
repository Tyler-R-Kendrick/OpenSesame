import { afterEach, expect, it, vi } from "vitest";
import * as codec from "./onepassword-sdk-codec.js";
import * as loader from "./onepassword-sdk-loader.js";
import { createOnePasswordSdkBackend } from "./onepassword-sdk.js";
import {
  itemId,
  nativeItem,
  nativeOverview,
  nativeVault,
  sdkFixture,
  vaultId,
} from "./onepassword-sdk.test-support.js";

// Injected native replies verify adapter composition, not hosted authentication or SDK cryptography.
afterEach(() => vi.restoreAllMocks());
it("captures frozen owned assets and the whole port without allocating until explicit authentication", async () => {
  const f = sdkFixture();
  expect(f.factory).not.toHaveBeenCalled();
  const fetcher = f.transport.fetch;
  Object.assign(f.transport, { fetch: vi.fn() });
  f.assets.runtimeUrl = "https://changed.invalid/runtime.js";
  const session = await f.backend.authenticate(f.config);
  const call = f.factory.mock.calls[0];
  expect(call?.[0]).toEqual({
    serviceAccountToken: f.config.token,
    accountOrigin: "https://account.1password.invalid",
    vaultId,
  });
  expect(Object.isFrozen(call?.[1])).toBe(true);
  expect(call?.[1].runtimeUrl).not.toBe(f.assets.runtimeUrl);
  expect(call?.[2].signal).toBe(f.owner.signal);
  expect(call?.[3]).toBe(f.owner.signal);
  await call?.[2].fetch("https://account.1password.invalid/fixture");
  expect(fetcher).toHaveBeenCalledOnce();
  expect(f.transport.fetch).not.toHaveBeenCalled();
  expect(f.invoke.mock.calls.map(([command]) => command.name)).toEqual([
    "VaultsList",
    "ItemsList",
  ]);
  expect(Object.isFrozen(session)).toBe(true);
  expect(JSON.stringify(session)).not.toMatch(
    /synthetic-native-token|client|assets|vaultId/,
  );
  expect(f.backend.signal).toBe(f.owner.signal);
  expect(session.signal).not.toBe(f.backend.signal);
  expect(f.backend.capabilities).toMatchObject({
    list: true,
    get: true,
    create: true,
    update: true,
    delete: true,
    import: false,
  });
  for (const key of ["createItem", "updateItem", "deleteItem"])
    expect(key in f.backend).toBe(true);
  expect("importToLocal" in f.backend).toBe(false);
  expect(f.backend.capabilities.vaultBackup).toEqual({
    kind: "note",
    field: "notes",
    maxBytes: 128 * 1024,
  });
  await f.backend.disconnect(session);
});
it("defaults to the actual browser SDK loader dependency without constructing it eagerly", async () => {
  const f = sdkFixture();
  const factory = vi
    .spyOn(loader, "createBrowserOnePasswordClient")
    .mockResolvedValue(f.client);
  const backend = createOnePasswordSdkBackend(f.assets, f.transport);
  expect(factory).not.toHaveBeenCalled();
  await backend.disconnect(await backend.authenticate(f.config));
  expect(factory).toHaveBeenCalledOnce();
});
it.each([
  { token: " " },
  { token: "x".repeat(16_385) },
  { vaultId: " " },
  { vaultId: "x".repeat(1025) },
  { baseUrl: "http://remote.invalid" },
  { baseUrl: "https://user:pass@account.invalid" },
  { baseUrl: "https://account.invalid/api" },
  { baseUrl: "https://account.invalid/?secret=private" },
  { baseUrl: "https://account.invalid/#private" },
])("rejects invalid settings before allocating %#", async (changes) => {
  const f = sdkFixture();
  await expect(
    f.backend.authenticate({ ...f.config, ...changes }),
  ).rejects.toMatchObject({ code: "configuration" });
  expect(f.factory).not.toHaveBeenCalled();
});
it.each(
  [
    [],
    [{ id: vaultId }],
    [nativeVault("NATIVE-FIXTURE-VAULT")],
    [nativeVault(), nativeVault()],
    [{ ...nativeVault(), createdAt: "2026-02-30T00:00:00Z" }],
    [{ ...nativeVault(), activeItemCount: -1 }],
    [{ ...nativeVault(), contentVersion: 1.5 }],
    [{ ...nativeVault(), vaultType: "future" }],
    [{ ...nativeVault(), title: "x".repeat(16_385) }],
  ].map((vaults) => ({ vaults })),
)(
  "requires a valid unique exact native vault before listing items %#",
  async ({ vaults }) => {
    const f = sdkFixture();
    f.invoke.mockResolvedValueOnce(vaults);
    await expect(f.backend.authenticate(f.config)).rejects.toMatchObject({
      code: "response",
    });
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith({ name: "VaultsList" });
    await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
  },
);
it.each(
  [[nativeOverview({ vaultId: "other" })], [{ id: itemId }]].map((items) => ({
    items,
  })),
)("requires a valid scoped native item-list probe %#", async ({ items }) => {
  const f = sdkFixture();
  f.invoke.mockResolvedValueOnce([nativeVault()]).mockResolvedValueOnce(items);
  await expect(f.backend.authenticate(f.config)).rejects.toMatchObject({
    code: "response",
  });
  await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
});
it("admits an accessible empty vault without trusting a metadata item count", async () => {
  const f = sdkFixture();
  f.invoke.mockResolvedValueOnce([nativeVault()]).mockResolvedValueOnce([]);
  const session = await f.backend.authenticate(f.config);
  expect(f.invoke).toHaveBeenCalledTimes(2);
  await f.backend.disconnect(session);
});
it("uses fresh native reads and returns actual normalized data and notes", async () => {
  const f = sdkFixture();
  const session = await f.backend.authenticate(f.config);
  f.invoke.mockClear();
  expect(await f.backend.listItems(session)).toEqual([
    { id: itemId, name: "Native login", kind: "login" },
  ]);
  expect(await f.backend.getItem("Native login", session)).toMatchObject({
    id: itemId,
    username: "native-user",
    secret: "private-native-marker",
  });
  expect(await f.backend.getNotes(itemId, session)).toBe(
    "native fixture notes",
  );
  expect(f.invoke.mock.calls.map(([command]) => command)).toEqual([
    { name: "ItemsList" },
    { name: "ItemsList" },
    { name: "ItemsGet", itemId },
    { name: "ItemsList" },
    { name: "ItemsGet", itemId },
  ]);
  await f.backend.disconnect(session);
});
it.each(["SecureNote", "ApiCredentials"])(
  "composes native %s reads and common notes fallback",
  async (category) => {
    const f = sdkFixture();
    const session = await f.backend.authenticate(f.config);
    f.invoke
      .mockResolvedValueOnce([nativeOverview({ category })])
      .mockResolvedValueOnce(
        nativeItem({
          category,
          notes: category === "SecureNote" ? "note" : "",
          fields:
            category === "SecureNote"
              ? []
              : [
                  {
                    id: "native-key",
                    title: "Key",
                    fieldType: "Concealed",
                    value: "native-secret",
                  },
                ],
        }),
      );
    expect(await f.backend.getNotes(itemId, session)).toBe(
      category === "SecureNote" ? "note" : "native-secret",
    );
    await f.backend.disconnect(session);
  },
);
it.each([{ vaultId: "other" }, { id: "other" }])(
  "rejects a full native item outside the selected scope %#",
  async (changes) => {
    const f = sdkFixture();
    const session = await f.backend.authenticate(f.config);
    f.invoke
      .mockResolvedValueOnce([nativeOverview()])
      .mockResolvedValueOnce(nativeItem(changes));
    await expect(f.backend.getItem(itemId, session)).rejects.toMatchObject({
      code: "response",
    });
    await f.backend.disconnect(session);
  },
);
it.each(
  [
    [nativeOverview({ state: "archived" })],
    [nativeOverview({ category: "Document" })],
    [nativeOverview(), nativeOverview({ id: "duplicate-title" })],
  ].map((rows) => ({ rows })),
)("does not fetch ambiguous or inactive selections %#", async ({ rows }) => {
  const f = sdkFixture();
  const session = await f.backend.authenticate(f.config);
  f.invoke.mockClear().mockResolvedValueOnce(rows);
  await expect(
    f.backend.getItem("Native login", session),
  ).rejects.toMatchObject({
    code: rows.length > 1 ? "ambiguous" : "not-found",
  });
  expect(f.invoke).toHaveBeenCalledExactlyOnceWith({ name: "ItemsList" });
  await f.backend.disconnect(session);
});
it("sanitizes factory and ordinary native errors while leaving a nonterminal session usable", async () => {
  const f = sdkFixture();
  f.factory.mockRejectedValueOnce(new Error("synthetic-native-token-marker"));
  await expect(f.backend.authenticate(f.config)).rejects.toThrow(
    "1Password could not complete the native vault operation.",
  );
  const session = await f.backend.authenticate(f.config);
  f.invoke.mockRejectedValueOnce(new Error("private-native-marker"));
  await expect(f.backend.listItems(session)).rejects.toThrow(
    "1Password could not complete the native vault operation.",
  );
  expect(session.signal?.aborted).toBe(false);
  expect(f.dispose).not.toHaveBeenCalled();
  expect(await f.backend.listItems(session)).toHaveLength(1);
  await f.backend.disconnect(session);
});
it.each(["owner", "native"] as const)(
  "checks %s again at the public item publication boundary",
  async (cause) => {
    const f = sdkFixture();
    const session = await f.backend.authenticate(f.config);
    const realDecoder = codec.readOnePasswordSdkItem;
    vi.spyOn(codec, "readOnePasswordSdkItem").mockImplementation((...args) => {
      const decoded = realDecoder(...args);
      queueMicrotask(() => f[cause].abort());
      return decoded;
    });
    await expect(f.backend.getItem(itemId, session)).rejects.toMatchObject({
      code: "stale",
    });
    expect(session.signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
  },
);
