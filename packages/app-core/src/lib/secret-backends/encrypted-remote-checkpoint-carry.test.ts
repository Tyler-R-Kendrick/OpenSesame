import type { CredentialItem } from "@opensesame/vault-core";
import { afterEach, expect, it } from "vitest";
import { readDeviceRows } from "../device-connector-records.js";
import { kvForgetAll } from "../kv.js";
import { vaultCredentialField } from "../vault-credential-custody.js";
import { vaultStore } from "../vault/store.js";
import { readSecretBackendCredentialItems } from "./credential-custody.js";
import { readEncryptedRemoteContinuity } from "./encrypted-remote-codec.js";
import { createEncryptedRemoteContinuity } from "./encrypted-remote-continuity.js";
import { createEncryptedRemoteBackend } from "./encrypted-remote.js";
import {
  encryptedRemoteFixture,
  freshLocalVault,
} from "./encrypted-remote.test-support.js";
import { saveSecretBackendConnection } from "./runtime.js";
import { remoteDraft, runtimePassword } from "./runtime.test-support.js";
import {
  hydrateSecretBackendConnections,
  readSecretBackendConnection,
} from "./store.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
async function setup() {
  const f = await encryptedRemoteFixture();
  closes.push(f.close);
  const draft = {
    ...remoteDraft(),
    baseUrl: f.config.objectUrl,
    encryptionKey: f.config.encryptionKey,
    remoteStoreId: f.config.storeId,
    token: f.config.bearerToken,
  };
  const saved = await saveSecretBackendConnection(draft);
  const readKey = (): CredentialItem => {
    const publicDraft = readSecretBackendConnection(saved.connectionId);
    const row = readDeviceRows().find(
      (item) => item.connectionId === saved.connectionId,
    );
    if (!publicDraft || !row) throw new Error("Saved connection is missing.");
    const items = readSecretBackendCredentialItems(
      publicDraft,
      vaultStore.getSnapshot().tomb,
      row.fields.secret_backend_credentials ?? "",
    );
    const item = items.find(
      (item) => vaultCredentialField(item) === "encryptionKey",
    );
    if (!item) throw new Error("Saved key reference is missing.");
    return item;
  };
  const backend = () => {
    const transport = f.capture().transport;
    return createEncryptedRemoteBackend(
      transport,
      createEncryptedRemoteContinuity(readKey, transport),
    );
  };
  const original = backend();
  return { ...f, draft, saved, readKey, backend, original };
}
it("preserves the authenticated floor on rename, fences the previous key reference and cold-reloads the new reference", async () => {
  const f = await setup();
  expect(readEncryptedRemoteContinuity(f.readKey(), f.config).revision).toBe(0);
  const session = await f.original.authenticate(f.config);
  await f.original.createItem?.(
    { name: "Newer note", notes: "revision two", secret: "" },
    session,
  );
  const oldId = f.readKey().id;
  await saveSecretBackendConnection(
    { ...f.draft, name: "Renamed", token: "", encryptionKey: "" },
    f.saved.connectionId,
  );
  expect(f.readKey().id).not.toBe(oldId);
  expect(readEncryptedRemoteContinuity(f.readKey(), f.config).revision).toBe(2);
  const puts = f.requests.filter((row) => row.method === "PUT").length;
  await expect(
    f.original.createItem?.(
      { name: "Withdrawn old key", notes: "", secret: "" },
      session,
    ),
  ).rejects.toThrow();
  expect(f.requests.filter((row) => row.method === "PUT")).toHaveLength(puts);
  vaultStore.lock();
  kvForgetAll();
  await vaultStore.unlock(runtimePassword);
  await hydrateSecretBackendConnections();
  const cold = f.backend();
  const current = await cold.authenticate(f.config);
  await cold.createItem?.(
    { name: "Cold session note", notes: "revision three", secret: "" },
    current,
  );
  expect(readEncryptedRemoteContinuity(f.readKey(), f.config).revision).toBe(3);
});
it("retains continuity across explicit same-target key replacement and refuses wrong-key authentication without overwriting", async () => {
  const f = await setup();
  const session = await f.original.authenticate(f.config);
  await f.original.createItem?.(
    { name: "Counter floor", notes: "", secret: "" },
    session,
  );
  const encryptionKey = Buffer.alloc(32, 33).toString("base64");
  await saveSecretBackendConnection(
    { ...f.draft, encryptionKey },
    f.saved.connectionId,
  );
  expect(readEncryptedRemoteContinuity(f.readKey(), f.config).revision).toBe(2);
  const puts = f.requests.filter((row) => row.method === "PUT").length;
  await expect(
    f.backend().authenticate({ ...f.config, encryptionKey }),
  ).rejects.toThrow();
  expect(f.requests.filter((row) => row.method === "PUT")).toHaveLength(puts);
});
it("uses an explicit new store identity without carrying an unrelated store floor", async () => {
  const f = await setup();
  await f.original.authenticate(f.config);
  const remoteStoreId = crypto.randomUUID();
  await saveSecretBackendConnection(
    { ...f.draft, remoteStoreId },
    f.saved.connectionId,
  );
  expect(
    readEncryptedRemoteContinuity(f.readKey(), {
      objectUrl: f.config.objectUrl,
      storeId: remoteStoreId,
    }).revision,
  ).toBe(0);
  expect(f.requests.every((row) => row.method === "GET")).toBe(true);
});
it("recovers a restored portable key floor before publishing a new device connection and rejects old ciphertext", async () => {
  const f = await setup();
  const old = f.state.bytes;
  const session = await f.original.authenticate(f.config);
  await f.original.createItem?.(
    { name: "Portable floor", notes: "", secret: "" },
    session,
  );
  await vaultStore.flushPendingWrites();
  const backup = vaultStore.exportSealed();
  const pin = "51793624";
  await freshLocalVault(f.files, pin);
  await vaultStore.importSealed(backup, runtimePassword, {
    adoptIdentity: false,
  });
  vaultStore.lock();
  kvForgetAll();
  await vaultStore.unlockWithPin(pin);
  await hydrateSecretBackendConnections();
  const replacement = await saveSecretBackendConnection(f.draft);
  const publicDraft = readSecretBackendConnection(replacement.connectionId);
  const row = readDeviceRows().find(
    (item) => item.connectionId === replacement.connectionId,
  );
  if (!publicDraft || !row)
    throw new Error("Restored configuration is missing.");
  const readKey = () => {
    const key = readSecretBackendCredentialItems(
      publicDraft,
      vaultStore.getSnapshot().tomb,
      row.fields.secret_backend_credentials ?? "",
    ).find((item) => vaultCredentialField(item) === "encryptionKey");
    if (!key) throw new Error("Missing restored key.");
    return key;
  };
  expect(readEncryptedRemoteContinuity(readKey(), f.config).revision).toBe(2);
  f.state.bytes = old;
  const transport = f.capture().transport;
  await expect(
    createEncryptedRemoteBackend(
      transport,
      createEncryptedRemoteContinuity(readKey, transport),
    ).authenticate(f.config),
  ).rejects.toMatchObject({ code: "stale" });
});
