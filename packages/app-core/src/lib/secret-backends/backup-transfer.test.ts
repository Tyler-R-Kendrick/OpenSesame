import { createItem, readVaultFile } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { vaultStore } from "../vault/store.js";
import {
  backUpVaultToSecretBackend,
  restoreVaultFromSecretBackend,
} from "./backup-transfer.js";
import { backupFixture } from "./backup-transfer.test-support.js";
import { deferred, runtimePassword } from "./runtime.test-support.js";

let fixture: Awaited<ReturnType<typeof backupFixture>>;
beforeEach(async () => {
  fixture = await backupFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.close();
});
async function sourceSecret() {
  const item = createItem("secret", "Original item");
  item.value = "original-plaintext-secret-fixture";
  await vaultStore.saveItem(item);
  return item;
}
async function purge(id: string) {
  await vaultStore.trashItem(id);
  await vaultStore.purgeItem(id);
}

it("transfers actual ciphertext over HTTP, verifies read-back, and restores through the real sealed merge without uploading the unlock password", async () => {
  const source = await sourceSecret();
  const backup = await backUpVaultToSecretBackend(
    fixture.open,
    "Ciphertext vault backup",
  );
  const posts = fixture.server.requests.filter(
    (request) => request.method === "POST",
  );
  expect(posts).toHaveLength(1);
  expect(posts[0]?.body).toContain("opensesame-offline-backup");
  expect(posts[0]?.body).not.toContain(source.value);
  expect(posts[0]?.body).not.toContain(runtimePassword);
  const saved = await fixture.open.backend.getItem(
    backup.id,
    fixture.open.session,
  );
  expect(readVaultFile(saved.notes).body.ctB64).toBeTruthy();
  await purge(source.id);
  const kept = createItem("note", "Keep this later note");
  kept.notes = "Newer note";
  await vaultStore.saveItem(kept);
  await expect(
    restoreVaultFromSecretBackend(fixture.open, backup.id, "wrong-password"),
  ).rejects.toThrow();
  expect(
    vaultStore.getSnapshot().items.some((item) => item.id === source.id),
  ).toBe(false);
  expect(
    await restoreVaultFromSecretBackend(
      fixture.open,
      backup.id,
      runtimePassword,
    ),
  ).toBe(1);
  expect(vaultStore.getSnapshot().items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: source.id, value: source.value }),
      expect.objectContaining({ id: kept.id }),
    ]),
  );
  expect(
    await restoreVaultFromSecretBackend(
      fixture.open,
      backup.id,
      runtimePassword,
    ),
  ).toBe(0);
});
it("also restores a PIN-only ciphertext backup with a transient PIN", async () => {
  const pin = "73918426";
  await vaultStore.enrollPin(pin);
  await vaultStore.removePassword();
  const source = await sourceSecret();
  const backup = await backUpVaultToSecretBackend(
    fixture.open,
    "PIN vault backup",
  );
  expect(
    fixture.server.requests
      .filter((request) => request.method === "POST")
      .every((request) => !request.body.includes(pin)),
  ).toBe(true);
  await purge(source.id);
  expect(
    await restoreVaultFromSecretBackend(fixture.open, backup.id, pin),
  ).toBe(1);
});
it("refuses truncated destination values and preflights declared size limits before a write", async () => {
  await sourceSecret();
  fixture.truncate();
  await expect(
    backUpVaultToSecretBackend(fixture.open, "Truncated backup"),
  ).rejects.toMatchObject({ code: "response" });
  const descriptor = fixture.open.backend.capabilities.vaultBackup;
  if (!descriptor) throw new Error("Expected a writable backup field");
  descriptor.maxBytes = 1;
  const before = fixture.server.requests.length;
  await expect(
    backUpVaultToSecretBackend(fixture.open, "Too large"),
  ).rejects.toMatchObject({ code: "unsupported" });
  expect(fixture.server.requests).toHaveLength(before);
});
it("generic notes are not backups, and guest or locked vaults cannot upload or restore", async () => {
  const item = await fixture.open.backend.createItem?.(
    {
      name: "Ordinary note",
      kind: "note",
      notes: "ordinary plaintext note",
      secret: "",
    },
    fixture.open.session,
  );
  if (!item) throw new Error("Expected remote note");
  await expect(
    restoreVaultFromSecretBackend(fixture.open, item.id, runtimePassword),
  ).rejects.toMatchObject({ code: "response" });
  vaultStore.lock();
  await expect(
    backUpVaultToSecretBackend(fixture.open, "Locked"),
  ).rejects.toMatchObject({ code: "locked" });
  await vaultStore.createGuest();
  const before = fixture.server.requests.length;
  await expect(
    backUpVaultToSecretBackend(fixture.open, "Guest"),
  ).rejects.toMatchObject({ code: "unsupported" });
  await expect(
    restoreVaultFromSecretBackend(fixture.open, item.id, runtimePassword),
  ).rejects.toMatchObject({ code: "unsupported" });
  expect(fixture.server.requests).toHaveLength(before);
});
it("a source lock during upload prevents a successful verification result", async () => {
  await sourceSecret();
  const paused = fixture.pause();
  const pending = backUpVaultToSecretBackend(fixture.open, "Paused upload");
  const failure = expect(pending).rejects.toMatchObject({ code: "stale" });
  await paused.entered;
  vaultStore.lock();
  paused.resume();
  await failure;
});
it("a lock and different vault activation during restore key derivation cannot receive the old vault's decrypted items", async () => {
  await sourceSecret();
  const backup = await backUpVaultToSecretBackend(fixture.open, "Restore race");
  const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
  const entered = deferred<void>();
  const resume = deferred<void>();
  vi.spyOn(crypto.subtle, "deriveKey").mockImplementationOnce(
    async (algorithm, key, type, extractable, usages) => {
      entered.resolve();
      await resume.promise;
      return derive(algorithm, key, type, extractable, usages);
    },
  );
  const pending = restoreVaultFromSecretBackend(
    fixture.open,
    backup.id,
    runtimePassword,
  );
  const failure = expect(pending).rejects.toThrow();
  await entered.promise;
  vaultStore.lock();
  await vaultStore.createGuest();
  resume.resolve();
  await failure;
  expect(vaultStore.getSnapshot()).toMatchObject({
    status: "unlocked",
    guest: true,
    items: [],
  });
});
