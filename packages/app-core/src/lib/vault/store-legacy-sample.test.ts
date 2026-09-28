/**
 * A vault that loaded the retired sample data, against a real vault store:
 * the synthetic items leave on the next unlock, and no manifest carries them.
 */
import { type VaultItem, createItem } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it } from "vitest";
import { storeManifestFile } from "../../sections/vault/import/store-manifest.js";
import { kvDelete } from "../kv.js";
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

const PASSWORD = "correct horse battery staple";

/** Let a fire-and-forget sealed write land, then forget the vault's files. */
async function clearVault(): Promise<void> {
  await vfsFlush();
  kvDelete(ATTEMPTS_KEY);
  for (const path of [
    HEADER_PATH,
    BODY_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
  ]) {
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  }
}

beforeEach(clearVault);

async function unlockedStore(): Promise<VaultStore> {
  const store = new VaultStore();
  await store.create(PASSWORD);
  return store;
}

describe("a vault that loaded the retired sample data", () => {
  it("drops the flagged items on the next unlock and keeps the rest", async () => {
    const store = await unlockedStore();
    const demoFolder = await store.addFolder("Sample data");
    const real = createItem("login", "Payroll");
    real.username = "ada";
    await store.saveItem(real);
    for (const name of ["GitHub", "Bank"]) {
      const demo = {
        ...createItem("login", name),
        folderId: demoFolder.id,
        sample: true,
      } as VaultItem;
      await store.saveItem(demo);
    }
    expect(store.getSnapshot().items).toHaveLength(3);
    await store.flushPendingWrites();
    store.lock();

    await store.unlock(PASSWORD);
    const after = store.getSnapshot();
    expect(after.items.map((item) => item.name)).toEqual(["Payroll"]);
    expect(after.folders).toEqual([]);
    expect(storeManifestFile(after.items, after.folders).count).toBe(1);
  });
});
