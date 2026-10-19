import { createItem, readVaultFile } from "@opensesame/vault-core";
import { afterEach, expect, it } from "vitest";
import { readDeviceRows } from "../device-connector-records.js";
import { kvForgetAll } from "../kv.js";
import { vaultStore } from "../vault/store.js";
import {
  backUpVaultToSecretBackend,
  restoreVaultFromSecretBackend,
} from "./backup-transfer.js";
import {
  encryptedRemoteFixture,
  freshLocalVault,
  independentOpen,
} from "./encrypted-remote.test-support.js";
import { createSecretBackend } from "./factory.js";
import { secretBackendDraft } from "./presets.js";
import {
  connectSecretBackend,
  initializeSecretBackend,
  probeSecretBackend,
  saveSecretBackendConnection,
} from "./runtime.js";
import { runtimePassword } from "./runtime.test-support.js";
import {
  hydrateSecretBackendConnections,
  readSecretBackendConnection,
} from "./store.js";
import { bindSecretBackendTransport } from "./transport.js";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
async function setup() {
  const f = await encryptedRemoteFixture();
  closes.push(f.close);
  const bind = () => {
    const unbind = bindSecretBackendTransport(f.capture().transport);
    closes.push(async () => unbind());
  };
  bind();
  const draft = {
    ...secretBackendDraft("encrypted-remote"),
    baseUrl: f.config.objectUrl,
    remoteStoreId: f.config.storeId,
    encryptionKey: f.config.encryptionKey,
    token: f.config.bearerToken,
  };
  return { ...f, draft, bind };
}
it("saves and cold-reloads the encrypted native mode through the actual common factory, authenticates and performs fenced CRUD", async () => {
  const f = await setup();
  const saved = await saveSecretBackendConnection(f.draft);
  expect(readSecretBackendConnection(saved.connectionId)).toMatchObject({
    encryptionKey: "",
    token: "",
    mode: "encrypted-remote",
  });
  expect(JSON.stringify(readDeviceRows())).not.toContain(
    f.config.encryptionKey,
  );
  vaultStore.lock();
  kvForgetAll();
  await vaultStore.unlock(runtimePassword);
  await hydrateSecretBackendConnections();
  f.bind();
  const handle = await connectSecretBackend(saved.connectionId);
  expect(await handle.backend.listItems(handle.session)).toContainEqual(
    expect.objectContaining({ name: "Independent fixture note" }),
  );
  const item = await handle.backend.createItem?.(
    { name: "Actual common port", notes: "secret note", secret: "" },
    handle.session,
  );
  if (!item) throw new Error("Missing CRUD capability.");
  expect(await handle.backend.getItem(item.id, handle.session)).toMatchObject({
    notes: "secret note",
  });
  await handle.backend.updateItem?.(
    item.id,
    { name: "Updated", notes: "new note", secret: "" },
    handle.session,
  );
  expect(
    independentOpen(f.state.bytes, f.config.objectUrl).items,
  ).toContainEqual(
    expect.objectContaining({ name: "Updated", notes: "new note" }),
  );
  await handle.backend.deleteItem?.(item.id, handle.session);
  expect(await handle.backend.listItems(handle.session)).not.toContainEqual(
    expect.objectContaining({ id: item.id }),
  );
  const count = f.requests.length;
  vaultStore.lock();
  await expect(handle.backend.listItems(handle.session)).rejects.toThrow();
  expect(f.requests).toHaveLength(count);
});
it("requires saved custody, keeps connect/probe read-only and exposes explicit fail-closed initialization", async () => {
  const f = await setup();
  f.state.missing = true;
  await expect(createSecretBackend("encrypted-remote")).rejects.toMatchObject({
    code: "configuration",
  });
  await expect(connectSecretBackend(f.draft)).rejects.toMatchObject({
    code: "configuration",
  });
  expect(f.requests).toHaveLength(0);
  const saved = await saveSecretBackendConnection(f.draft);
  await expect(connectSecretBackend(saved.connectionId)).rejects.toMatchObject({
    code: "not-found",
  });
  await expect(
    probeSecretBackend(
      { ...f.draft, token: "", encryptionKey: "" },
      saved.connectionId,
    ),
  ).rejects.toMatchObject({ code: "not-found" });
  expect(f.requests.every((row) => row.method === "GET")).toBe(true);
  const handle = await initializeSecretBackend(saved.connectionId);
  expect(await handle.backend.listItems(handle.session)).toEqual([]);
  expect(f.requests.filter((row) => row.method === "PUT")).toEqual([
    expect.objectContaining({ noneMatch: "*", match: "" }),
  ]);
  await handle.backend.disconnect(handle.session);
  f.state.missing = true;
  const count = f.requests.length;
  await expect(
    initializeSecretBackend(saved.connectionId),
  ).rejects.toMatchObject({ code: "stale" });
  expect(f.requests).toHaveLength(count);
});
it("rejects genuine rollback through a newly activated saved runtime after cold reload", async () => {
  const f = await setup();
  const old = f.state.bytes;
  const saved = await saveSecretBackendConnection(f.draft);
  const handle = await connectSecretBackend(saved.connectionId);
  await handle.backend.createItem?.(
    { name: "Monotonic", notes: "", secret: "" },
    handle.session,
  );
  vaultStore.lock();
  kvForgetAll();
  await vaultStore.unlock(runtimePassword);
  await hydrateSecretBackendConnections();
  f.bind();
  f.state.bytes = old;
  await expect(connectSecretBackend(saved.connectionId)).rejects.toMatchObject({
    code: "stale",
  });
});
it("uses the mounted common runtime for sealed backup and restore into a different PIN vault", async () => {
  const f = await setup();
  const sourcePin = "73918426";
  await vaultStore.enrollPin(sourcePin);
  await vaultStore.removePassword();
  const item = createItem("secret", "Mounted backup source");
  item.value = "portable ciphertext source";
  await vaultStore.saveItem(item);
  const saved = await saveSecretBackendConnection(f.draft);
  const handle = await connectSecretBackend(saved.connectionId);
  const backup = await backUpVaultToSecretBackend(
    handle,
    "Mounted encrypted backup",
  );
  expect(
    f.requests
      .filter((row) => row.method === "PUT")
      .every((row) => !row.body.includes(item.value)),
  ).toBe(true);
  await handle.backend.disconnect(handle.session);
  const pin = "84261973";
  await freshLocalVault(f.files, pin);
  const targetIdentity = readVaultFile(vaultStore.exportSealed()).header.unlocks
    ?.pin;
  await hydrateSecretBackendConnections();
  f.bind();
  const replacement = await saveSecretBackendConnection(f.draft);
  const cold = await connectSecretBackend(replacement.connectionId);
  await expect(
    restoreVaultFromSecretBackend(cold, backup.id, pin),
  ).rejects.toThrow();
  expect(
    await restoreVaultFromSecretBackend(cold, backup.id, sourcePin),
  ).toBeGreaterThan(0);
  vaultStore.lock();
  kvForgetAll();
  await expect(vaultStore.unlockWithPin(sourcePin)).rejects.toThrow();
  await vaultStore.unlockWithPin(pin);
  expect(vaultStore.getSnapshot().items).toContainEqual(
    expect.objectContaining({ id: item.id, value: item.value }),
  );
  expect(readVaultFile(vaultStore.exportSealed()).header.unlocks?.pin).toEqual(
    targetIdentity,
  );
});
