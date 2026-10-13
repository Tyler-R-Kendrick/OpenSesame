/** Actual source graph loaded by Vite independently of Vitest module mocks. */
import { loadPack, packEntries } from "@opensesame/vault-item-types";
import { configureHost } from "../../../host.js";
import { createTestHost } from "../../../test-host.js";
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
} from "../../vfs.js";
import { ATTEMPTS_KEY } from "../store.js";
import { LEGACY_PREFS_KEY } from "../tomb-migration.js";
export { createItem } from "@opensesame/vault-core";
export { VaultStore } from "../store.js";
export { isDecoySession } from "../../duress/store/decoy-scratch.js";
export { vfsFlush };
export { assertOwnedStorageWrites } from "../../../test-host-storage-writes.js";
export { wipeGuard } from "../../duress/wipe/guard.js";
export async function prepare(): Promise<void> {
  await Promise.all(packEntries().map((entry) => loadPack(entry.id)));
  configureHost(createTestHost());
}
export function header(): string | null {
  return kvGet(tombFileKey(PERSONAL_TOMB, HEADER_PATH));
}
export function body(): string | null {
  return kvGet(tombFileKey(PERSONAL_TOMB, BODY_PATH));
}
export async function reset(): Promise<void> {
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
  kvDelete(LEGACY_PREFS_KEY);
  writeLastVaultId(PERSONAL_TOMB);
}
