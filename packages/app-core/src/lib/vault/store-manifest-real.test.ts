/**
 * The store path manifest against a real, unlocked vault store: the write
 * the Import sheet makes, end to end.
 */
import { createItem } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  planStoreManifest,
  readStoreManifest,
  storeManifestFile,
} from "../../sections/vault/import/store-manifest.js";
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

describe("the store path manifest in a real vault", () => {
  it("exports, and importing it twice into another vault never duplicates", async () => {
    const source = await unlockedStore();
    const dev = await source.addFolder("Dev");
    const login = createItem("login", "GitHub");
    login.username = "octo";
    login.password = "hunter2-but-longer"; // gitleaks:allow -- fixture
    await source.saveItem({ ...login, folderId: dev.id });
    const secret = createItem("secret", "Deploy hook");
    secret.value = "whsec_fixture"; // gitleaks:allow -- fixture
    await source.saveItem(secret);
    const snapshot = source.getSnapshot();
    const file = storeManifestFile(snapshot.items, snapshot.folders);
    await source.flushPendingWrites();
    source.lock();
    await clearVault();

    const target = await unlockedStore();
    const entries = readStoreManifest(JSON.parse(file.text));
    expect(entries).toHaveLength(2);
    if (entries === null) return;

    for (const round of [1, 2]) {
      const { items, folders } = target.getSnapshot();
      const plan = planStoreManifest(entries, items, folders);
      if (round === 2) {
        expect(plan).toMatchObject({ adds: [], updates: [], unchanged: 2 });
      }
      await target.applyManifestMerge(plan);
    }

    const after = target.getSnapshot();
    expect(after.items.map((item) => item.name).sort()).toEqual([
      "Deploy hook",
      "GitHub",
    ]);
    expect(after.folders.map((folder) => folder.name)).toEqual(["Dev"]);
    const github = after.items.find((item) => item.name === "GitHub");
    expect(github).toMatchObject({ kind: "login", username: "octo" });
    expect(github?.folderId).toBe(after.folders[0]?.id);
  });
});
