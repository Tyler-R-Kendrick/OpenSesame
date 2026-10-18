import { createItem, readVaultFile } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureDeviceIdentityKey } from "../device-identity-key.js";
import { kvFlush } from "../kv.js";
import { unwrapExportedVaultKey } from "../vault/offline-backup-file.js";
import { bodyPortOf } from "../vault/store-device-key.js";
import { vaultStore } from "../vault/store.js";
import { vfsFlush } from "../vfs.js";
import {
  backUpVaultToSecretBackend,
  restoreVaultFromSecretBackend,
} from "./backup-transfer.js";
import { backupFixture } from "./backup-transfer.test-support.js";
import { deferred, runtimePassword } from "./runtime.test-support.js";

let fixture: Awaited<ReturnType<typeof backupFixture>>;
const keys: Uint8Array[] = [];
const releases: (() => void)[] = [];
const tasks: Promise<number>[] = [];
beforeEach(async () => {
  fixture = await backupFixture();
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(tasks.splice(0));
  for (const key of keys.splice(0)) key.fill(0);
  vi.restoreAllMocks();
  await fixture.close();
});
async function flush() {
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await kvFlush();
}
function actionOwner() {
  const controller = new AbortController();
  return {
    withdraw: () => controller.abort(),
    check: () => {
      if (controller.signal.aborted)
        throw new DOMException("This action ended.", "AbortError");
    },
  };
}
async function preparedBackup(secret = runtimePassword) {
  const sourceKey = await ensureDeviceIdentityKey(
    vaultStore.getSnapshot().tomb,
  );
  const source = createItem("secret", "Only in the backup");
  source.value = "encrypted-owner-lifetime-canary";
  await vaultStore.saveItem(source);
  const backup = await backUpVaultToSecretBackend(fixture.open, "Owned backup");
  const stored = await fixture.open.backend.getItem(
    backup.id,
    fixture.open.session,
  );
  const raw = await unwrapExportedVaultKey(
    readVaultFile(stored.notes).header,
    secret,
  );
  keys.push(raw);
  await vaultStore.trashItem(source.id);
  await vaultStore.purgeItem(source.id);
  const kept = createItem("note", "Keep the destination's later item");
  await vaultStore.saveItem(kept);
  await flush();
  return { source, backup, raw, kept, identity: sourceKey.keyId };
}
function holdBodyDecrypt(
  prepared: Awaited<ReturnType<typeof preparedBackup>>,
  check?: () => void,
) {
  const entered = deferred<void>();
  const resume = deferred<void>();
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...args) => {
    // The raw key skips unwrapping: this is the real sealed body decryption.
    const plaintext = await decrypt(...args);
    entered.resolve();
    await resume.promise;
    return plaintext;
  });
  releases.push(() => resume.resolve());
  const pending = restoreVaultFromSecretBackend(
    fixture.open,
    prepared.backup.id,
    prepared.raw,
    undefined,
    check,
  );
  tasks.push(pending);
  void pending.catch(() => {});
  return { entered: entered.promise, resume: () => resume.resolve(), pending };
}
function expectDestination(
  prepared: Awaited<ReturnType<typeof preparedBackup>>,
) {
  expect(vaultStore.getSnapshot().items).toEqual([
    expect.objectContaining({ id: prepared.kept.id }),
  ]);
  expect(bodyPortOf(vaultStore).body().deviceIdentityKey).toMatchObject({
    keyId: prepared.identity,
  });
}

it("refuses an already withdrawn action before any upload or restore network I/O", async () => {
  const owner = actionOwner();
  owner.withdraw();
  const before = fixture.server.requests.length;
  await expect(
    backUpVaultToSecretBackend(
      fixture.open,
      "Ended upload",
      undefined,
      owner.check,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  await expect(
    restoreVaultFromSecretBackend(
      fixture.open,
      "unread-backup",
      runtimePassword,
      undefined,
      owner.check,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fixture.server.requests).toHaveLength(before);
});

it("withdraws an action during real body decrypt before the bound importer can merge", async () => {
  const prepared = await preparedBackup();
  const owner = actionOwner();
  const held = holdBodyDecrypt(prepared, owner.check);
  await held.entered;
  owner.withdraw();
  held.resume();
  await expect(held.pending).rejects.toMatchObject({ name: "AbortError" });
  await flush();
  expectDestination(prepared);
});

it("ends an actual provider session during decrypt without merging its old response", async () => {
  const prepared = await preparedBackup();
  const held = holdBodyDecrypt(prepared);
  await held.entered;
  await fixture.open.backend.disconnect(fixture.open.session);
  expect(fixture.open.session.signal?.aborted).toBe(true);
  held.resume();
  await expect(held.pending).rejects.toMatchObject({ code: "stale" });
  await flush();
  expectDestination(prepared);
});

it("retains the existing vault-owner fence across lock and another vault activation", async () => {
  const prepared = await preparedBackup();
  const held = holdBodyDecrypt(prepared, actionOwner().check);
  await held.entered;
  vaultStore.lock();
  await vaultStore.createGuest();
  held.resume();
  await expect(held.pending).rejects.toThrow();
  expect(vaultStore.getSnapshot()).toMatchObject({ guest: true, items: [] });
});

it("lets the current operation merge once while preserving later items and destination identity", async () => {
  const prepared = await preparedBackup();
  const owner = actionOwner();
  const held = holdBodyDecrypt(prepared, owner.check);
  await held.entered;
  held.resume();
  await expect(held.pending).resolves.toBe(1);
  expect(vaultStore.getSnapshot().items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: prepared.kept.id }),
      expect.objectContaining({
        id: prepared.source.id,
        value: prepared.source.value,
      }),
    ]),
  );
  expect(bodyPortOf(vaultStore).body().deviceIdentityKey).toMatchObject({
    keyId: prepared.identity,
  });
  expect(prepared.raw.some((byte) => byte !== 0)).toBe(true);
  await expect(
    restoreVaultFromSecretBackend(
      fixture.open,
      prepared.backup.id,
      prepared.raw,
      undefined,
      owner.check,
    ),
  ).resolves.toBe(0);
});

it("rejects a wrong PIN without changing destination items or identity", async () => {
  const pin = "73918426";
  await vaultStore.enrollPin(pin);
  await vaultStore.removePassword();
  const prepared = await preparedBackup(pin);
  await expect(
    restoreVaultFromSecretBackend(
      fixture.open,
      prepared.backup.id,
      "73918427",
      undefined,
      actionOwner().check,
    ),
  ).rejects.toThrow();
  expectDestination(prepared);
});
