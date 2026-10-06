/**
 * Reading the device-sealed history database for the move into the encrypted
 * one (ADR 0175). Lives with the optional library, not the store it reads, so
 * the core entry carries none of it.
 */

import type { BoundaryValue } from "@opensesame/os-domain";
import { type AtRestKey, atRestReady } from "../at-rest/key.js";
import {
  ACCOUNTS,
  ENTRIES,
  asAccount,
  asEntry,
  idbReq,
  openRow,
  present,
} from "../history-backup-legacy.js";
import type {
  HistoryEntryRecord,
  ProvisionalHistoryAccount,
} from "../history-backup-types.js";
import { openLegacySource } from "../legacy-transfer.js";
import { storageWritesHalted } from "../storage-halt.js";
import { HISTORY_BACKUP_DATABASE } from "../storage-ownership.js";

export type LegacyHistory = {
  accounts: ProvisionalHistoryAccount[];
  entries: HistoryEntryRecord[];
};

/**
 * Everything the sealed database holds, opened, for moving into the
 * encrypted one; undefined when there is nothing to move or it cannot be
 * opened (no durable key, no database).
 */
export async function readLegacyHistory(): Promise<LegacyHistory | undefined> {
  if (storageWritesHalted()) return undefined;
  let atRest: AtRestKey;
  try {
    atRest = await atRestReady();
    if (!atRest.durable) return undefined;
    const db = await openLegacySource(HISTORY_BACKUP_DATABASE);
    if (!db) return undefined;
    try {
      return readLegacyHistoryFrom(db, atRest);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export async function readLegacyHistoryFrom(
  db: IDBDatabase,
  atRest: AtRestKey,
): Promise<LegacyHistory> {
  const tx = db.transaction([ACCOUNTS, ENTRIES], "readonly");
  const accounts: BoundaryValue[] = await idbReq(
    tx.objectStore(ACCOUNTS).getAll(),
  );
  const entries: BoundaryValue[] = await idbReq(
    tx.objectStore(ENTRIES).getAll(),
  );
  return {
    accounts: accounts
      .map((row) => asAccount(openRow(atRest, ACCOUNTS, row)))
      .filter(present),
    entries: entries
      .map((row) => asEntry(openRow(atRest, ENTRIES, row)))
      .filter(present),
  };
}
