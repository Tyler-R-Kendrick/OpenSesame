/** @vitest-environment jsdom */
import {
  createCredential,
  createItem,
  manualPassword,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { kvDelete } from "../kv.js";
import { writeLastVaultId } from "../last-vault.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "../vfs.js";
import {
  installPasswordDigestStore,
  resetPasswordHistoryForTest,
} from "./password-history.js";
import { ATTEMPTS_KEY, VaultStore } from "./store.js";

const PASSWORD = "correct horse battery staple";
let store: VaultStore;

beforeEach(async () => {
  await vfsFlush();
  for (const path of [
    BODY_PATH,
    HEADER_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
    "config/device-identity-key",
  ])
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  kvDelete(ATTEMPTS_KEY);
  writeLastVaultId(PERSONAL_TOMB);
  resetPasswordHistoryForTest();
  store = new VaultStore();
  await store.create(PASSWORD);
});

afterEach(async () => {
  store.lock();
  installPasswordDigestStore(null);
  await vfsFlush();
});

function pauseRetirement() {
  let resume = () => {};
  let entered = () => {};
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    resume = resolve;
  });
  installPasswordDigestStore({
    add: async () => true,
    forget: async () => 0,
    digestsFor: async () => {
      entered();
      await wait;
      return [];
    },
  });
  return { reached, resume };
}

function stagedCredential() {
  return createCredential(
    manualPassword(
      crypto.randomUUID(),
      "Staged password",
      new Date().toISOString(),
    ),
    "Must stay out of the guest",
  );
}

it.each(["single", "batch"])(
  "refuses a %s write when a different vault opens during password retirement",
  async (kind) => {
    const original = createItem("note", "Original vault");
    await store.saveItem(original);
    const paused = pauseRetirement();
    const pendingItem = stagedCredential();
    const pending =
      kind === "single"
        ? store.saveItem(pendingItem)
        : store.saveItems([pendingItem]);
    const refused = expect(pending).rejects.toMatchObject({
      code: "stale_operation",
    });
    await paused.reached;
    store.lock();
    await store.createGuest();
    paused.resume();
    await refused;
    expect(store.getSnapshot().items).toEqual([]);
    store.lock();
    writeLastVaultId(PERSONAL_TOMB);
    const reopened = new VaultStore();
    reopened.rehydrate();
    await reopened.unlock(PASSWORD);
    expect(reopened.getSnapshot().items.map((item) => item.name)).toEqual([
      original.name,
    ]);
    reopened.lock();
  },
);

it("refuses a cancelled connection's staged tokens before the queued mutation", async () => {
  const paused = pauseRetirement();
  let active = true;
  const pending = store.saveItems([stagedCredential()], undefined, () => {
    if (!active) throw new Error("Connection cancelled");
  });
  const refused = expect(pending).rejects.toThrow("Connection cancelled");
  await paused.reached;
  active = false;
  paused.resume();
  await refused;
  expect(store.getSnapshot().items).toEqual([]);
  await store.flushPendingWrites();
  store.lock();
  await store.unlock(PASSWORD);
  expect(store.getSnapshot().items).toEqual([]);
});
