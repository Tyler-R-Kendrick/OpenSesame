/** @vitest-environment jsdom */
import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
import { ATTEMPTS_KEY, VaultStore } from "./store.js";

const gate = vi.hoisted(() => ({ wait: Promise.resolve() }));
vi.mock("./password-history.js", async (original) => {
  const actual = await original<typeof import("./password-history.js")>();
  return {
    ...actual,
    preparePasswordRetirement: async (
      ...args: Parameters<typeof actual.preparePasswordRetirement>
    ) => {
      await gate.wait;
      return actual.preparePasswordRetirement(...args);
    },
  };
});

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
  gate.wait = Promise.resolve();
  store = new VaultStore();
  await store.create(PASSWORD);
});

afterEach(async () => {
  store.lock();
  gate.wait = Promise.resolve();
  await vfsFlush();
});

function pauseRetirement() {
  let resume = () => {};
  gate.wait = new Promise<void>((resolve) => {
    resume = resolve;
  });
  return resume;
}

it.each(["single", "batch"])(
  "refuses a %s write when a different vault opens during password retirement",
  async (kind) => {
    const original = createItem("note", "Original vault");
    await store.saveItem(original);
    const resume = pauseRetirement();
    const pendingItem = createItem("note", "Must stay out of the guest");
    const pending =
      kind === "single"
        ? store.saveItem(pendingItem)
        : store.saveItems([pendingItem]);
    const refused = expect(pending).rejects.toMatchObject({
      code: "stale_operation",
    });
    store.lock();
    await store.createGuest();
    resume();
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
  const resume = pauseRetirement();
  let active = true;
  const pending = store.saveItems(
    [createItem("note", "Cancelled staged credential")],
    undefined,
    () => {
      if (!active) throw new Error("Connection cancelled");
    },
  );
  const refused = expect(pending).rejects.toThrow("Connection cancelled");
  active = false;
  resume();
  await refused;
  expect(store.getSnapshot().items).toEqual([]);
  await store.flushPendingWrites();
  store.lock();
  await store.unlock(PASSWORD);
  expect(store.getSnapshot().items).toEqual([]);
});
