/** Real owner cryptography with completion/fault holds; no admission stub. */
import * as vaultCore from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { kvDelete, kvGet } from "../../kv.js";
import { writeLastVaultId } from "../../last-vault.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
  vfsSeams,
} from "../../vfs.js";
import { ATTEMPTS_KEY, VaultStore } from "../store.js";
import { LEGACY_PREFS_KEY } from "../tomb-migration.js";
const PASSWORD = "correct horse battery staple";
const NEXT_PASSWORD = "a new actual owner password for the control";
const HEADER_KEY = tombFileKey(PERSONAL_TOMB, HEADER_PATH);
const BODY_KEY = tombFileKey(PERSONAL_TOMB, BODY_PATH);
const stores: VaultStore[] = [];
function gate() {
  let announce = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, held, announce, release };
}
async function owner() {
  const store = new VaultStore();
  stores.push(store);
  await store.create(PASSWORD);
  await store.protection.ensureProtectionProjected();
  const item = vaultCore.createItem("note", "same-generation control");
  item.notes = "the actual owner payload";
  await store.saveItem(item);
  await vfsFlush();
  return { store, item };
}
beforeEach(async () => {
  await vfsFlush();
  kvDelete(ATTEMPTS_KEY);
  for (const path of [
    HEADER_PATH,
    BODY_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
  ])
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  kvDelete(LEGACY_PREFS_KEY);
  writeLastVaultId(PERSONAL_TOMB);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.lock();
  await vfsFlush();
});
it("does not restore an older in-memory header over a concurrent committed protector after an unaccepted write fails", async () => {
  const { store, item } = await owner();
  await store.enrollPin("83619472");
  await store.protection.ensureProtectionProjected();
  const records = store.protection.listProtectors();
  const password = records.find((record) => record.kind === "password");
  const pin = records.find((record) => record.kind === "pin");
  if (!password || !pin)
    throw new Error("The real owner did not enroll both methods.");
  const delivery = gate();
  const actualWrite = vfsSeams.writeRaw;
  let once = true;
  const observe = vi
    .spyOn(vfsSeams, "writeRaw")
    .mockImplementation(async (...args) => {
      if (args[0] === HEADER_KEY && once) {
        once = false;
        delivery.announce();
        await delivery.held;
        throw new Error(
          "Controlled failure before this physical header write was accepted.",
        );
      }
      return actualWrite(...args);
    });
  const pending = store.protection.setPreferred(password.protectorId);
  const refusal = expect(pending).rejects.toMatchObject({
    code: "stale_operation",
  });
  try {
    await delivery.entered;
    await store.protection.setPreferred(pin.protectorId);
    const committed = kvGet(HEADER_KEY);
    delivery.release();
    await refusal;
    expect(kvGet(HEADER_KEY)).toBe(committed);
    expect(store.getSnapshot().header?.protection?.preferredProtectorId).toBe(
      pin.protectorId,
    );
    store.lock();
    await store.unlock(PASSWORD);
    expect(store.getSnapshot().header?.protection?.preferredProtectorId).toBe(
      pin.protectorId,
    );
    expect(
      store.getSnapshot().items.find((entry) => entry.id === item.id)?.notes,
    ).toBe(item.notes);
  } finally {
    delivery.release();
    await refusal.catch(() => undefined);
    observe.mockRestore();
  }
});
it("refuses a rotation whose actual old-password wrap completes after the owner changed that password in the same generation", async () => {
  const { store, item } = await owner();
  const delivery = gate();
  const actualWrap = vaultCore.wrapVaultKeyWithPassword;
  let once = true;
  const observe = vi
    .spyOn(vaultCore, "wrapVaultKeyWithPassword")
    .mockImplementation(async (...args) => {
      const pause = once;
      once = false;
      const wrapped = await actualWrap(...args);
      if (pause) {
        delivery.announce();
        await delivery.held;
      }
      return wrapped;
    });
  const pending = store.protection.rotateCompromisedRoot({
    password: PASSWORD,
  });
  const refusal = expect(pending).rejects.toMatchObject({
    code: "stale_operation",
  });
  try {
    await delivery.entered;
    await store.changeMasterPassword(PASSWORD, NEXT_PASSWORD);
    const header = kvGet(HEADER_KEY);
    const body = kvGet(BODY_KEY);
    delivery.release();
    await refusal;
    await vfsFlush();
    expect(kvGet(HEADER_KEY)).toBe(header);
    expect(kvGet(BODY_KEY)).toBe(body);
    store.lock();
    await expect(store.unlock(PASSWORD)).rejects.toBeInstanceOf(
      vaultCore.WrongPasswordError,
    );
    await store.unlock(NEXT_PASSWORD);
    expect(
      store.getSnapshot().items.find((entry) => entry.id === item.id)?.notes,
    ).toBe(item.notes);
  } finally {
    delivery.release();
    await refusal.catch(() => undefined);
    observe.mockRestore();
  }
});
