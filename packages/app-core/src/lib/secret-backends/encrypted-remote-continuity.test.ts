import { type CredentialItem, createCredential } from "@opensesame/vault-core";
import { afterEach, expect, it, vi } from "vitest";
import { kvForgetAll, kvSeams } from "../kv.js";
import { vaultStore } from "../vault/store.js";
import { BODY_PATH, tombFileKey } from "../vfs.js";
import {
  ENCRYPTED_REMOTE_CONTINUITY_FIELD,
  createEncryptedRemoteContinuity,
  encryptedRemoteContinuitySeed,
  readEncryptedRemoteContinuity,
} from "./encrypted-remote-continuity.js";
import { createEncryptedRemoteBackend } from "./encrypted-remote.js";
import {
  encryptedRemoteFixture,
  freshLocalVault,
  independentSeal,
  initialStore,
} from "./encrypted-remote.test-support.js";
import { runtimePassword } from "./runtime.test-support.js";
import type { SecretBackendTransport } from "./transport.js";

const closes: (() => Promise<void>)[] = [];
const pending: Promise<unknown>[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  await Promise.allSettled(pending.splice(0));
});
async function setup() {
  const f = await encryptedRemoteFixture();
  closes.push(f.close);
  const id = crypto.randomUUID();
  const key = createCredential(
    { id, type: "token", token: f.config.encryptionKey, expiresAt: "" },
    "Inventory encryption key",
  );
  key.fields.push(encryptedRemoteContinuitySeed(f.config));
  await vaultStore.saveItem(key);
  const readKey = (): CredentialItem => {
    const item = vaultStore.getSnapshot().items.find((row) => row.id === id);
    if (!item || item.kind !== "credential")
      throw new Error("The original inventory key left its vault.");
    return item;
  };
  const backend = (transport: SecretBackendTransport) =>
    createEncryptedRemoteBackend(
      transport,
      createEncryptedRemoteContinuity(readKey, transport),
    );
  return { ...f, readKey, backend, original: backend(f.transport) };
}
it("seals revision/digest into the actual key Token and rejects genuine old ciphertext after a fresh vault/session activation", async () => {
  const f = await setup();
  const old = f.state.bytes;
  const session = await f.original.authenticate(f.config);
  expect(readEncryptedRemoteContinuity(f.readKey(), f.config).revision).toBe(1);
  await f.original.createItem?.(
    { name: "Newer authenticated note", notes: "kept", secret: "" },
    session,
  );
  expect(readEncryptedRemoteContinuity(f.readKey(), f.config).revision).toBe(2);
  await f.original.disconnect(session);
  vaultStore.lock();
  kvForgetAll();
  await vaultStore.unlock(runtimePassword);
  f.state.bytes = old;
  const cold = f.backend(f.capture().transport);
  await expect(cold.authenticate(f.config)).rejects.toMatchObject({
    code: "stale",
  });
  f.state.bytes = independentSeal(initialStore(2), f.config.objectUrl);
  await expect(cold.authenticate(f.config)).rejects.toMatchObject({
    code: "stale",
  });
  expect(readEncryptedRemoteContinuity(f.readKey(), f.config).revision).toBe(2);
});
it.each(["missing", "duplicate", "malformed"])(
  "refuses %s durable checkpoint metadata without a provider write",
  async (mode) => {
    const f = await setup();
    const item = structuredClone(f.readKey());
    const field = item.fields.find(
      (row) => row.id === ENCRYPTED_REMOTE_CONTINUITY_FIELD,
    );
    if (!field) throw new Error("Missing seeded continuity field");
    if (mode === "missing")
      item.fields = item.fields.filter((row) => row !== field);
    if (mode === "duplicate") item.fields.push({ ...field });
    if (mode === "malformed") field.value = "malformed";
    await vaultStore.saveItem(item);
    await expect(f.original.authenticate(f.config)).rejects.toThrow();
    expect(f.requests.every((row) => row.method === "GET")).toBe(true);
  },
);
it("fails authentication if its monotonic point cannot be durably committed, preserving the previous point", async () => {
  const f = await setup();
  const original = kvSeams.kvSetDurable;
  const body = tombFileKey(vaultStore.getSnapshot().tomb, BODY_PATH);
  const fail = vi
    .spyOn(kvSeams, "kvSetDurable")
    .mockImplementation((key, value, check) =>
      key === body
        ? Promise.reject(new Error("Owned storage failure"))
        : original(key, value, check),
    );
  try {
    await expect(f.original.authenticate(f.config)).rejects.toThrow(
      "Owned storage failure",
    );
  } finally {
    fail.mockRestore();
  }
  expect(readEncryptedRemoteContinuity(f.readKey(), f.config).revision).toBe(0);
  expect(f.requests.every((row) => row.method === "GET")).toBe(true);
});
it("carries the authenticated point through a real sealed backup into a fresh PIN vault", async () => {
  const f = await setup();
  const session = await f.original.authenticate(f.config);
  const old = f.state.bytes;
  await f.original.createItem?.(
    { name: "Portable continuity", notes: "point", secret: "" },
    session,
  );
  await f.original.disconnect(session);
  await vaultStore.flushPendingWrites();
  const exported = vaultStore.exportSealed();
  const pin = "51938642";
  await freshLocalVault(f.files, pin);
  await vaultStore.importSealed(exported, runtimePassword, {
    adoptIdentity: false,
  });
  vaultStore.lock();
  kvForgetAll();
  await vaultStore.unlockWithPin(pin);
  expect(readEncryptedRemoteContinuity(f.readKey(), f.config).revision).toBe(2);
  f.state.bytes = old;
  await expect(
    f.backend(f.capture().transport).authenticate(f.config),
  ).rejects.toMatchObject({ code: "stale" });
});
it("withdrawal while a real read is held cannot advance the stored point or send a late write", async () => {
  const f = await setup();
  const session = await f.original.authenticate(f.config);
  f.state.bytes = independentSeal(initialStore(2), f.config.objectUrl);
  f.state.hold = true;
  const rejected = expect(f.original.listItems(session)).rejects.toThrow();
  pending.push(rejected);
  await f.entered.promise;
  vaultStore.lock();
  f.release.resolve();
  await rejected;
  await vaultStore.unlock(runtimePassword);
  expect(readEncryptedRemoteContinuity(f.readKey(), f.config).revision).toBe(1);
  expect(f.requests.every((row) => row.method === "GET")).toBe(true);
});
