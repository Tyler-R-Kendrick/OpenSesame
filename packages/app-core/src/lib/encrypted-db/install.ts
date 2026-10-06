/**
 * Turn encrypted search on for the stores that keep identifiers (ADR 0175):
 * route history backups and retired-password digests to encrypted databases,
 * move what the device-sealed databases hold across, and delete them - their
 * database, store and index names, and the ids and scopes they keep readable,
 * go with them.
 *
 * Called by the `storage.encrypted-search` capability's runtime and by
 * nothing else; turning the capability off routes the stores back and leaves
 * the encrypted databases where they are, unreadable without the device key.
 */

import { maybeIndexedDatabases } from "../../ports.js";
import { atRestReady } from "../at-rest/key.js";
import { installHistoryRowStore } from "../history-backup-idb.js";
import {
  type LegacyKind,
  type TransferClaim,
  claimLegacyTransfer,
  fenceLegacyDatabase,
} from "../legacy-transfer.js";
import {
  HISTORY_BACKUP_DATABASE,
  PASSWORD_HISTORY_DATABASE,
} from "../storage-ownership.js";
import { installPasswordDigestStore } from "../vault/password-history.js";
import { createHistoryStore } from "./history-store.js";
import { readLegacyDigests, readLegacyDigestsFrom } from "./legacy-digests.js";
import { readLegacyHistory, readLegacyHistoryFrom } from "./legacy-history.js";
import { createPasswordDigestStore } from "./password-store.js";

export type MigrationReport = Readonly<{
  complete: boolean;
  /** Rows moved, and whether the old database was then deleted. */
  history: Readonly<{ moved: number; removed: boolean }>;
  digests: Readonly<{ moved: number; removed: boolean }>;
}>;

const NOTHING = { moved: 0, removed: false } as const;

async function transfer(
  kind: LegacyKind,
  name: string,
  copy: (db: IDBDatabase, claim: TransferClaim) => Promise<number>,
  onClaim: (claim: TransferClaim) => void,
) {
  // Calling migration again explicitly retries an interrupted claim. Replaced
  // owners cannot copy further or dispatch deletion after losing their token.
  const claim = await claimLegacyTransfer(kind, true);
  onClaim(claim);
  let db: IDBDatabase | undefined;
  let moved = 0;
  try {
    db = await fenceLegacyDatabase(name);
    await claim.assertOwned();
    if (!db) return { moved: 0, removed: false, complete: true };
    moved = await copy(db, claim);
    await claim.assertOwned();
    db.close();
    db = undefined;
    // IDB deletion cannot be cancelled. With cooperative opens fenced, it is
    // dispatched only after all target commits and an ownership check; never
    // report a timeout while leaving a late deletion queued.
    await new Promise<void>((resolve, reject) => {
      const factory = maybeIndexedDatabases();
      if (!factory) throw new Error("IndexedDB unavailable");
      const deletion = factory.deleteDatabase(name);
      deletion.onsuccess = () => resolve();
      deletion.onerror = () =>
        reject(deletion.error ?? new Error("Legacy deletion failed"));
    });
    return { moved, removed: true, complete: true };
  } catch {
    db?.close();
    await claim.release();
    return { moved, removed: false, complete: false };
  }
}

async function migrateHistory(onClaim: (claim: TransferClaim) => void) {
  await readLegacyHistory();
  return transfer(
    "history-backups",
    HISTORY_BACKUP_DATABASE,
    async (db, claim) => {
      const legacy = await readLegacyHistoryFrom(db, await atRestReady());
      const target = createHistoryStore(undefined, claim.guardWrite);
      let moved = 0;
      for (const account of legacy.accounts) {
        await claim.assertOwned();
        if ((await target.putAccount(account)) !== true)
          throw new Error("History transfer failed");
        moved += 1;
      }
      for (const entry of legacy.entries) {
        await claim.assertOwned();
        if ((await target.putEntry(entry)) !== true)
          throw new Error("History transfer failed");
        moved += 1;
      }
      return moved;
    },
    onClaim,
  );
}

async function migrateDigests(onClaim: (claim: TransferClaim) => void) {
  await readLegacyDigests();
  return transfer(
    "password-history",
    PASSWORD_HISTORY_DATABASE,
    async (db, claim) => {
      const legacy = await readLegacyDigestsFrom(db, await atRestReady());
      const target = createPasswordDigestStore(undefined, claim.guardWrite);
      let moved = 0;
      for (const { scope, digest } of legacy) {
        await claim.assertOwned();
        if ((await target.add(scope, digest)) !== true)
          throw new Error("Digest transfer failed");
        moved += 1;
      }
      return moved;
    },
    onClaim,
  );
}

/** Move whatever the device-sealed databases hold into the encrypted ones. */
export async function migrateLegacyStores(): Promise<MigrationReport> {
  return migrateStores(() => {});
}

async function migrateStores(
  onClaim: (claim: TransferClaim) => void,
): Promise<MigrationReport> {
  const history = await migrateHistory(onClaim);
  const digests = await migrateDigests(onClaim);
  return {
    complete: history.complete && digests.complete,
    history: { moved: history.moved, removed: history.removed },
    digests: { moved: digests.moved, removed: digests.removed },
  };
}

export type EncryptedStores = Readonly<{
  /** Settles once the device-sealed databases have been moved; never rejects. */
  migrated: Promise<MigrationReport>;
  /** Route the stores back to the device-sealed databases. */
  uninstall: () => Promise<void>;
}>;

export function installEncryptedStores(): EncryptedStores {
  // Reads wait for the move, so a row written before this tab turned the
  // capability on is never reported missing.
  const claims: TransferClaim[] = [];
  const migrated = migrateStores((claim) => claims.push(claim)).catch(
    (): MigrationReport => ({
      complete: false,
      history: NOTHING,
      digests: NOTHING,
    }),
  );
  const ready = async () => {
    const report = await migrated;
    if (!(await atRestReady()).durable) return;
    if (!report.complete)
      throw new Error(
        "Encrypted storage transfer incomplete; retry activation",
      );
  };
  const stopHistory = installHistoryRowStore(createHistoryStore(ready));
  const stopDigests = installPasswordDigestStore(
    createPasswordDigestStore(ready),
  );
  return {
    migrated,
    uninstall: async () => {
      await migrated;
      for (const claim of claims) await claim.release();
      stopHistory();
      stopDigests();
    },
  };
}
