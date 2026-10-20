import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
} from "./device-connector-records.js";
import { ensureDeviceIdentityKey } from "./device-identity-key.js";
import { kvForgetAll, kvHydrate } from "./kv.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import { bindNativeProviderTransport } from "./native-connector-transport.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";
import { AZURE_FIXTURE_TOKEN } from "./secret-backends/azure-key-vault-http.test-support.js";
import {
  type SecretBackendBackupHandle,
  backUpVaultToSecretBackend,
  restoreVaultFromSecretBackend,
} from "./secret-backends/backup-transfer.js";
import { openSavedAzureKeyVaultBackend } from "./secret-backends/factory.js";
import {
  azureSavedFixture,
  azureSocketClosed,
} from "./test/native-azure-secrets-backup-fixture.js";
import { vaultStore } from "./vault/store.js";

let fixture: Awaited<ReturnType<typeof azureSavedFixture>>;
const handles: SecretBackendBackupHandle[] = [];
beforeEach(async () => {
  fixture = await azureSavedFixture();
});
afterEach(async () => {
  for (const handle of handles.splice(0))
    await handle.backend.disconnect(handle.session);
  await fixture.close();
});
async function open(signal?: AbortSignal) {
  const handle = await openSavedAzureKeyVaultBackend(
    fixture.saved.connectionId,
    { transport: fixture.transport, vault: vaultStore, signal },
  );
  handles.push(handle);
  return handle;
}
function secret(name = "factory-secret", value = "native-crud-secret") {
  return { name, kind: "secret" as const, secret: value, notes: "" };
}
async function change(
  update: (
    current: NonNullable<ReturnType<typeof loadNativeConnectorRecord>>,
  ) => void,
) {
  const saved = loadNativeConnectorRecord(fixture.saved.connectionId);
  if (!saved) throw new Error("Missing saved Azure record");
  return updateNativeConnector(
    saved.connectionId,
    nativeOAuthGuard(saved),
    { publicParameters: ["vault_url"], privateCredentials: ["token"] },
    (current) => {
      update(current);
      return current;
    },
  );
}
it("opens the actual factory from one sealed native record and executes real versioned CRUD", async () => {
  const handle = await open();
  const { backend, session } = handle;
  if (!backend.createItem || !backend.updateItem || !backend.deleteItem)
    throw new Error("Azure CRUD missing");
  const created = await backend.createItem(secret(), session);
  expect(created.name).toBe("factory-secret");
  expect(created.secret).toBe("native-crud-secret");
  const original = fixture.service.versions.get(created.name)?.[0];
  if (!original) throw new Error("Native secret not stored");
  original.tags = { owned: "preserve-metadata" };
  original.contentType = "owned/type";
  expect(await backend.listItems(session)).toEqual([
    { id: created.id, name: created.name, kind: "secret" },
  ]);
  await backend.updateItem(
    created.id,
    secret(created.name, "new-native-version"),
    session,
  );
  const versions = fixture.service.versions.get(created.name);
  expect(versions).toHaveLength(2);
  expect(versions?.[1]?.tags).toEqual(original.tags);
  expect(versions?.[1]?.contentType).toBe(original.contentType);
  expect((await backend.getItem(original.id, session)).secret).toBe(
    "native-crud-secret",
  );
  expect(await backend.getNotes(created.id, session)).toBe(
    "new-native-version",
  );
  await backend.deleteItem(created.id, session);
  expect(fixture.service.deleted.get(created.name)).toHaveLength(2);
  expect(await backend.listItems(session)).toEqual([]);
  expect(readDeviceRows()).toHaveLength(1);
  expect([...fixture.disk.files.values()].join()).not.toContain(
    AZURE_FIXTURE_TOKEN,
  );
  expect(JSON.stringify(session)).not.toContain(AZURE_FIXTURE_TOKEN);
  expect(fixture.disk.fetcher).not.toHaveBeenCalled();
});
it("cold loads the same sealed native credential without a second credential store", async () => {
  kvForgetAll();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  const handle = await open();
  if (!handle.backend.createItem) throw new Error("Missing Azure create");
  const created = await handle.backend.createItem(secret(), handle.session);
  expect(
    (await handle.backend.getItem(created.id, handle.session)).secret,
  ).toBe("native-crud-secret");
  expect(readDeviceRows()).toHaveLength(1);
  expect(
    loadNativeConnectorRecord(fixture.saved.connectionId)?.privateState
      .credentials.token,
  ).toBe(AZURE_FIXTURE_TOKEN);
  expect([...fixture.disk.files.values()].join()).not.toContain(
    AZURE_FIXTURE_TOKEN,
  );
});
it("backs up real PIN-protected ciphertext, reads it back and restores through the importer", async () => {
  await ensureDeviceIdentityKey(vaultStore.getSnapshot().tomb);
  await vaultStore.enrollPin("83619472");
  await vaultStore.removePassword();
  const source = createItem("secret", "Azure source");
  source.value = "azure-plaintext-canary";
  await vaultStore.saveItem(source);
  const handle = await open();
  const saved = await backUpVaultToSecretBackend(
    handle,
    "sealed-backup",
    vaultStore,
  );
  const stored = await handle.backend.getItem(saved.id, handle.session);
  expect(stored.secret).not.toContain(source.value);
  expect(stored.secret).not.toContain(AZURE_FIXTURE_TOKEN);
  await vaultStore.trashItem(source.id);
  await vaultStore.purgeItem(source.id);
  expect(
    await restoreVaultFromSecretBackend(
      handle,
      saved.id,
      "83619472",
      vaultStore,
    ),
  ).toBe(1);
  expect(vaultStore.getSnapshot().items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: source.id, value: source.value }),
    ]),
  );
});
it("rejects oversized encrypted backups before any PUT", async () => {
  await ensureDeviceIdentityKey(vaultStore.getSnapshot().tomb);
  const source = createItem("secret", "Too large");
  source.value = "x".repeat(30000);
  await vaultStore.saveItem(source);
  const handle = await open();
  await expect(
    backUpVaultToSecretBackend(handle, "large-backup", vaultStore),
  ).rejects.toMatchObject({ code: "unsupported" });
  expect(
    fixture.service.requests.some((request) => request.method === "PUT"),
  ).toBe(false);
});
it.each(["target", "key", "method"])(
  "refuses changed saved %s before authenticated I/O",
  async (kind) => {
    await change((current) => {
      if (kind === "target")
        current.configuration.parameters.vault_url =
          "https://other.vault.azure.net";
      if (kind === "key")
        current.privateState.credentials.token = "another-key";
      if (kind === "method") current.configuration.method = "oauth";
    });
    const count = fixture.service.requests.length;
    await expect(open()).rejects.toThrow();
    expect(fixture.service.requests).toHaveLength(count);
  },
);
it.each(["caller", "vault", "provider", "record"])(
  "%s withdrawal cancels the original body before release",
  async (kind) => {
    fixture.service.seed("held-secret", "owned");
    const caller = new AbortController();
    const handle = await open(caller.signal);
    const held = fixture.service.holdNext(200);
    const pending = handle.backend.getItem("held-secret", handle.session);
    const refused = expect(pending).rejects.toThrow();
    await held.arrived;
    if (kind === "caller") caller.abort();
    if (kind === "vault") vaultStore.lock();
    if (kind === "provider") fixture.service.controller.abort();
    if (kind === "record")
      await change((current) => {
        current.configuration.displayName = "changed";
      });
    await refused;
    await azureSocketClosed(held.closed);
    const count = fixture.service.requests.length;
    await expect(handle.backend.listItems(handle.session)).rejects.toThrow();
    expect(fixture.service.requests).toHaveLength(count);
    held.release();
  },
);
it("captures original native authority before its first durable await and never borrows replacement", async () => {
  const release = bindNativeProviderTransport(fixture.transport);
  const count = fixture.service.requests.length;
  const pending = openSavedAzureKeyVaultBackend(fixture.saved.connectionId, {
    vault: vaultStore,
  });
  const rejected = expect(pending).rejects.toThrow();
  const fetch = vi.fn<typeof globalThis.fetch>();
  const replacement = bindNativeProviderTransport({
    fetch,
    signal: new AbortController().signal,
    assertCurrent: () => {},
  });
  try {
    await rejected;
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.service.requests).toHaveLength(count);
  } finally {
    replacement();
    release();
  }
});
it.each([401, 403])(
  "HTTP%s invalidates the same native proof without retry",
  async (status) => {
    const handle = await open();
    const count = fixture.service.requests.length;
    fixture.service.faultNext({ status, body: { error: AZURE_FIXTURE_TOKEN } });
    await expect(
      handle.backend.listItems(handle.session),
    ).rejects.toMatchObject({ status });
    expect(fixture.service.requests).toHaveLength(count + 1);
    expect(readNativeConnector(fixture.saved.connectionId)?.status).toBe(
      "configuration",
    );
    await expect(handle.backend.listItems(handle.session)).rejects.toThrow();
    expect(fixture.service.requests).toHaveLength(count + 1);
  },
);
it("requires original opaque session identity and keeps independent handles separate", async () => {
  const original = await open();
  const independent = await open();
  await expect(
    original.backend.listItems({ ...original.session }),
  ).rejects.toThrow();
  await original.backend.disconnect(original.session);
  expect(await independent.backend.listItems(independent.session)).toEqual([]);
});

it("retires both lifetimes when an already-open native authority is replaced, without ending an independent handle", async () => {
  const independent = await open();
  const release = bindNativeProviderTransport(fixture.transport);
  const original = await openSavedAzureKeyVaultBackend(
    fixture.saved.connectionId,
    { vault: vaultStore },
  );
  handles.push(original);
  const fetch = vi.fn<typeof globalThis.fetch>();
  const replacement = bindNativeProviderTransport({
    fetch,
    signal: new AbortController().signal,
    assertCurrent: () => {},
  });
  const count = fixture.service.requests.length;
  try {
    await expect(
      original.backend.listItems(original.session),
    ).rejects.toThrow();
    expect(original.backend.signal?.aborted).toBe(true);
    expect(original.session.signal?.aborted).toBe(true);
    await expect(
      original.backend.getItem("blocked", original.session),
    ).rejects.toThrow();
    expect(fixture.service.requests).toHaveLength(count);
    expect(fetch).not.toHaveBeenCalled();
    expect(await independent.backend.listItems(independent.session)).toEqual(
      [],
    );
    expect(independent.backend.signal?.aborted).toBe(false);
  } finally {
    replacement();
    release();
  }
});
