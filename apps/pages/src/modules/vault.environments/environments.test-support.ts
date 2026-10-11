/**
 * Set-up shared by the Environments tests: the real vault store on the real
 * VFS, opened fresh, and a plan that approves the capability.
 */

import { kvDelete } from "@opensesame/app-core/lib/kv.js";
import { ENVIRONMENTS_CAPABILITY } from "@opensesame/app-core/lib/vault/environments.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "@opensesame/app-core/lib/vfs.js";
import {
  type VaultItem,
  createItem,
  syncInstalledTypes,
} from "@opensesame/vault-core";

export const PASSWORD = "correct horse battery staple";

export const APPROVED_PLAN = {
  approvedCapabilities: [ENVIRONMENTS_CAPABILITY],
};

/** The personal tomb as a new device has it. */
export async function clearPersonalTomb(): Promise<void> {
  await vfsFlush();
  syncInstalledTypes({});
  for (const path of [
    BODY_PATH,
    HEADER_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
  ]) {
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  }
}

/** A new vault, open, holding one secret per name. */
export async function openVaultWith(...names: string[]): Promise<VaultItem[]> {
  await clearPersonalTomb();
  await vaultStore.create(PASSWORD);
  const items = names.map((name) => createItem("secret", name));
  await vaultStore.saveItems(items);
  return items;
}

export async function closeVault(): Promise<void> {
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  vaultStore.lock();
  await vaultStore.destroy();
}
