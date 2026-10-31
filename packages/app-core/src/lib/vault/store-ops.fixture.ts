/** Explicit owners and clean storage for the store operation/lifecycle suites. */
import { afterEach, beforeEach } from "vitest";
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
import { ATTEMPTS_KEY, PREFS_CONFIG_PATH, VaultStore } from "./store.js";
import { LEGACY_PREFS_KEY } from "./tomb-migration.js";

export const PASSWORD = "correct horse battery staple";
export const NEXT_PASSWORD = "fourteen ungulate carriage nail";
export const HEADER_KEY = tombFileKey(PERSONAL_TOMB, HEADER_PATH);
export const BODY_KEY = tombFileKey(PERSONAL_TOMB, BODY_PATH);
const stores: VaultStore[] = [];

export function clearVault(): void {
  kvDelete(ATTEMPTS_KEY);
  kvDelete(HEADER_KEY);
  kvDelete(BODY_KEY);
  kvDelete(LEGACY_PREFS_KEY);
  kvDelete(tombFileKey(PERSONAL_TOMB, PREFS_CONFIG_PATH));
  // Re-run unlock-time migration; the index was sealed with the former key.
  kvDelete(tombFileKey(PERSONAL_TOMB, MIGRATION_MARKER_PATH));
  kvDelete(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
}

export function newStore(): VaultStore {
  const store = new VaultStore();
  stores.push(store);
  return store;
}

export async function unlockedStore(): Promise<VaultStore> {
  const store = newStore();
  await store.create(PASSWORD);
  return store;
}

export function installStoreOperationsFixture(): void {
  beforeEach(async () => {
    await vfsFlush();
    clearVault();
  });
  afterEach(async () => {
    const owned = stores.splice(0);
    try {
      await Promise.all(owned.map((store) => store.flushPendingWrites()));
    } finally {
      for (const store of owned) store.lock();
    }
  });
}
