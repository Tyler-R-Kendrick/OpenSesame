/**
 * Turn encrypted search on for the stores that keep identifiers (ADR 0173):
 * route history backups and retired-password digests to encrypted databases,
 * move what the device-sealed databases hold across, and delete them - their
 * database, store and index names, and the ids and scopes they keep readable,
 * go with them.
 *
 * Called by the `storage.encrypted-search` capability's runtime and by
 * nothing else; turning the capability off routes the stores back and leaves
 * the encrypted databases where they are, unreadable without the device key.
 */

import { installHistoryRowStore } from "../history-backup-idb.js";
import { readLegacyHistory } from "../history-backup-legacy.js";
import {
  HISTORY_BACKUP_DATABASE,
  PASSWORD_HISTORY_DATABASE,
} from "../storage-ownership.js";
import { readLegacyDigests } from "../vault/password-history-legacy.js";
import { installPasswordDigestStore } from "../vault/password-history.js";
import { createHistoryStore } from "./history-store.js";
import { deleteDatabase } from "./idb.js";
import { createPasswordDigestStore } from "./password-store.js";

export type MigrationReport = Readonly<{
  /** Rows moved, and whether the old database was then deleted. */
  history: Readonly<{ moved: number; removed: boolean }>;
  digests: Readonly<{ moved: number; removed: boolean }>;
}>;

const NOTHING = { moved: 0, removed: false } as const;

async function migrateHistory() {
  const legacy = await readLegacyHistory();
  if (!legacy) return NOTHING;
  const target = createHistoryStore();
  let moved = 0;
  for (const account of legacy.accounts) {
    if ((await target.putAccount(account)) !== true)
      return { moved, removed: false };
    moved += 1;
  }
  for (const entry of legacy.entries) {
    if ((await target.putEntry(entry)) !== true)
      return { moved, removed: false };
    moved += 1;
  }
  try {
    await deleteDatabase(HISTORY_BACKUP_DATABASE);
    return { moved, removed: true };
  } catch {
    return { moved, removed: false };
  }
}

async function migrateDigests() {
  const legacy = await readLegacyDigests();
  if (!legacy) return NOTHING;
  const target = createPasswordDigestStore();
  let moved = 0;
  for (const { scope, digest } of legacy) {
    if ((await target.add(scope, digest)) !== true)
      return { moved, removed: false };
    moved += 1;
  }
  try {
    await deleteDatabase(PASSWORD_HISTORY_DATABASE);
    return { moved, removed: true };
  } catch {
    return { moved, removed: false };
  }
}

/** Move whatever the device-sealed databases hold into the encrypted ones. */
export async function migrateLegacyStores(): Promise<MigrationReport> {
  return { history: await migrateHistory(), digests: await migrateDigests() };
}

export type EncryptedStores = Readonly<{
  /** Settles once the device-sealed databases have been moved; never rejects. */
  migrated: Promise<MigrationReport>;
  /** Route the stores back to the device-sealed databases. */
  uninstall: () => void;
}>;

export function installEncryptedStores(): EncryptedStores {
  // Reads wait for the move, so a row written before this tab turned the
  // capability on is never reported missing.
  const migrated = migrateLegacyStores().catch(
    (): MigrationReport => ({ history: NOTHING, digests: NOTHING }),
  );
  const ready = async () => {
    await migrated;
  };
  installHistoryRowStore(createHistoryStore(ready));
  installPasswordDigestStore(createPasswordDigestStore(ready));
  return {
    migrated,
    uninstall: () => {
      installHistoryRowStore(null);
      installPasswordDigestStore(null);
    },
  };
}
