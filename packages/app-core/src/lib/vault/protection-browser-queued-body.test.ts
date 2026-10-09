/** Genuine owner BODY, a queued original transport, and fresh real unlock. */
import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { kvDelete, kvGet } from "../kv.js";
import { writeLastVaultId } from "../last-vault.js";
import * as vfs from "../vfs.js";
import { ATTEMPTS_KEY, VaultStore } from "./store.js";
import { LEGACY_PREFS_KEY } from "./tomb-migration.js";
const PASSWORD = "correct horse battery staple";
const HEADER_KEY = vfs.tombFileKey(vfs.PERSONAL_TOMB, vfs.HEADER_PATH);
const BODY_KEY = vfs.tombFileKey(vfs.PERSONAL_TOMB, vfs.BODY_PATH);
const BLOCKER_KEY = vfs.tombFileKey(vfs.PERSONAL_TOMB, "control-blocker");
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
beforeEach(async () => {
  await vfs.vfsFlush();
  kvDelete(ATTEMPTS_KEY);
  for (const path of [
    vfs.HEADER_PATH,
    vfs.BODY_PATH,
    vfs.INDEX_PATH,
    vfs.MIGRATION_MARKER_PATH,
    "control-blocker",
  ])
    kvDelete(vfs.tombFileKey(vfs.PERSONAL_TOMB, path));
  kvDelete(LEGACY_PREFS_KEY);
  writeLastVaultId(vfs.PERSONAL_TOMB);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.lock();
  await vfs.vfsFlush();
});
it("does not start an old queued BODY write with the fresh owner's tomb key", async () => {
  const store = new VaultStore();
  stores.push(store);
  await store.create(PASSWORD);
  const item = createItem("note", "queued BODY owner control");
  item.notes = "original owner text";
  await store.saveItem(item);
  const fresh = gate();
  let observingFresh = false;
  let installedKey: CryptoKey | undefined;
  const actualUnlock = vfs.unlockTomb;
  const unlockObserve = vi
    .spyOn(vfs, "unlockTomb")
    .mockImplementation((...args) => {
      actualUnlock(...args);
      if (args[0] === vfs.PERSONAL_TOMB) {
        installedKey = args[1];
        if (observingFresh) fresh.announce();
      }
    });
  store.lock();
  await store.unlock(PASSWORD);
  const originalKey = installedKey;
  expect(originalKey).toBeDefined();
  const header = kvGet(HEADER_KEY);
  const body = kvGet(BODY_KEY);
  const blocker = gate();
  const queued = gate();
  const actualWrite = vfs.vfsSeams.writeRaw;
  let held = false;
  const writeObserve = vi
    .spyOn(vfs.vfsSeams, "writeRaw")
    .mockImplementation(async (...args) => {
      await actualWrite(...args);
      if (args[0] === BLOCKER_KEY && !held) {
        held = true;
        blocker.announce();
        await blocker.held;
      }
    });
  const actualSealed = vfs.writeSealedFile;
  const queuedObserve = vi
    .spyOn(vfs, "writeSealedFile")
    .mockImplementation((...args) => {
      const result = actualSealed(...args);
      if (args[1] === vfs.BODY_PATH) queued.announce();
      return result;
    });
  const blocking = vfs.writeFile(
    vfs.PERSONAL_TOMB,
    "control-blocker",
    new TextEncoder().encode("real sealed blocker"),
  );
  await blocker.entered;
  const edit = { ...item, notes: "an old-generation queued edit" };
  const pending = store.saveItem(edit);
  // Attach a drain immediately; assert the original promise only once queue IO can settle.
  const settled = pending.catch(() => undefined);
  let freshOpening: Promise<void> | undefined;
  let freshSettled: Promise<void> | undefined;
  try {
    await queued.entered;
    store.lock();
    observingFresh = true;
    freshOpening = store.unlock(PASSWORD);
    freshSettled = freshOpening.catch(() => undefined);
    // Real primary unwrap installs a new key before unlock's queued retired-config cleanup.
    // Waiting for all of unlock while the queue is held deadlocks this fixture.
    await fresh.entered;
    expect(installedKey).toBeDefined();
    expect(installedKey).not.toBe(originalKey);
    blocker.release();
    await blocking;
    await expect(pending).rejects.toMatchObject({ code: "stale_operation" });
    await freshOpening;
    await vfs.vfsFlush();
    expect(writeObserve.mock.calls.some(([path]) => path === BODY_KEY)).toBe(
      false,
    );
    expect(kvGet(HEADER_KEY)).toBe(header);
    expect(kvGet(BODY_KEY)).toBe(body);
    expect(
      store.getSnapshot().items.find((entry) => entry.id === item.id)?.notes,
    ).toBe(item.notes);
    queuedObserve.mockRestore();
    writeObserve.mockRestore();
    await store.saveItem({ ...item, notes: "fresh owner edit" });
    store.lock();
    await store.unlock(PASSWORD);
    expect(
      store.getSnapshot().items.find((entry) => entry.id === item.id)?.notes,
    ).toBe("fresh owner edit");
  } finally {
    blocker.release();
    await blocking.catch(() => undefined);
    await settled;
    await freshSettled;
    queuedObserve.mockRestore();
    writeObserve.mockRestore();
    unlockObserve.mockRestore();
  }
});
