/**
 * Shared set-up for the Trusted contacts storage tests: a real vault store on
 * the real VFS, and circles made by the real engine through the desk's own
 * test devices, so the records under test are ones the desk would save.
 */

import { kvDelete } from "@opensesame/app-core/lib/kv.js";
import {
  Clock,
  armedCircle,
  who,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import type { OwnedRecord } from "@opensesame/app-core/lib/quorum/desk/ports.js";
import type { HeldRecord } from "@opensesame/app-core/lib/quorum/records.js";
import { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "@opensesame/app-core/lib/vfs.js";
import { syncInstalledTypes } from "@opensesame/vault-core";

export const PASSWORD = "correct horse battery staple";

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

/** A new vault, open. */
export async function openVault(): Promise<VaultStore> {
  await clearPersonalTomb();
  const store = new VaultStore();
  await store.create(PASSWORD);
  return store;
}

export async function closeVault(store: VaultStore): Promise<void> {
  await store.flushPendingWrites();
  await vfsFlush();
  store.lock();
  syncInstalledTypes({});
}

/** Close the vault and open it again, as a reload does: a new store over the same files. */
export async function reopenVault(store: VaultStore): Promise<VaultStore> {
  await closeVault(store);
  const again = new VaultStore();
  await again.unlock(PASSWORD);
  return again;
}

export type Records = Readonly<{
  /** A circle with shares, 2 of 3, and what its owner keeps. */
  owned: OwnedRecord;
  /** What Ada holds of that circle: a wrapped share. */
  share: HeldRecord;
  /** An approvals-only circle, and what its owner keeps. */
  actionOwned: OwnedRecord;
  /** What Ben holds of that one: a seat, no share. */
  seat: HeldRecord;
}>;

function only<T>(found: readonly T[], what: string): T {
  const [first] = found;
  if (first === undefined) throw new Error(`no ${what}`);
  return first;
}

let made: Promise<Records> | null = null;

/** Two circles made once for the file: they are read-only fixtures. */
export function records(): Promise<Records> {
  made ??= (async () => {
    const clock = new Clock();
    const recovering = await armedCircle(clock);
    const action = await armedCircle(clock, { recovers: false });
    return {
      owned: only(await recovering.owner.records.owned(), "owned circle"),
      share: only(await who(recovering, "Ada").records.held(), "share"),
      actionOwned: only(await action.owner.records.owned(), "action circle"),
      seat: only(await who(action, "Ben").records.held(), "seat"),
    };
  })();
  return made;
}
