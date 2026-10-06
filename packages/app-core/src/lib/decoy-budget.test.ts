import { createItem } from "@opensesame/vault-core";
import { afterEach, expect, it } from "vitest";
import { VaultStore } from "./vault/store.js";
let store: VaultStore | null = null;
afterEach(() => store?.lock());
it("rolls back item and byte budget failures in the actual decoy store", async () => {
  store = new VaultStore();
  await store.createGuest({ decoy: true });
  const safe = createItem("note", "Safe");
  await store.saveItem(safe);
  const saved = store.getSnapshot().items;
  await expect(
    store.addItems(
      Array.from({ length: 100 }, () => createItem("note", "Too many")),
    ),
  ).rejects.toThrow("storage limit");
  expect(store.getSnapshot().items).toEqual(saved);
  const large = createItem("note", "Large");
  large.notes = "x".repeat(256 * 1024);
  await expect(store.saveItem(large)).rejects.toThrow("storage limit");
  expect(store.getSnapshot().items).toEqual(saved);
});
it("does not impose the decoy byte limit on an ordinary real vault", async () => {
  store = new VaultStore();
  await store.createWithPin("89673142");
  const large = createItem("note", "Large");
  large.notes = "x".repeat(256 * 1024);
  await expect(store.saveItem(large)).resolves.toBeUndefined();
  expect(store.getSnapshot().items[0]?.id).toBe(large.id);
  expect(store.getSnapshot().items[0]?.notes.length).toBe(256 * 1024);
});
