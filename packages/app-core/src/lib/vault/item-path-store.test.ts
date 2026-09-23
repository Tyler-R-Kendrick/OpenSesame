import { expect, it } from "vitest";
import { kvSeams } from "../kv.js";
import { resolveItemPath } from "./item-path.js";
import { createItem } from "./model.js";
import { VaultStore } from "./store.js";

it("rolls back a staged folder on write failure and persists it with the item on retry", async () => {
  const store = new VaultStore();
  const password = "test-only correct horse battery staple";
  await store.create(password);
  const resolved = resolveItemPath("./test/login", null, []);
  const item = {
    ...createItem("note", resolved.name),
    folderId: resolved.folderId,
  };
  const write = kvSeams.kvSetDurable;
  try {
    kvSeams.kvSetDurable = async () => {
      throw new Error("Test storage full");
    };
    await expect(store.saveItem(item, resolved.folder)).rejects.toThrow(
      "storage full",
    );
    expect(store.getSnapshot().folders).toEqual([]);
    expect(store.getSnapshot().items).toEqual([]);
  } finally {
    kvSeams.kvSetDurable = write;
  }
  await store.saveItem(item, resolved.folder);
  store.lock();
  const reopened = new VaultStore();
  await reopened.unlock(password);
  expect(reopened.getSnapshot().folders).toEqual([resolved.folder]);
  expect(reopened.getSnapshot().items[0]).toMatchObject({
    name: "login",
    folderId: resolved.folderId,
  });
  reopened.lock();
});
