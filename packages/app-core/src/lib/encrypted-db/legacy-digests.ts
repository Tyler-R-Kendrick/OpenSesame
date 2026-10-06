/**
 * Reading the device-sealed digest database for the move into the encrypted
 * one (ADR 0175). Lives with the optional library, not the store it reads, so
 * the core entry carries none of it.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { type AtRestKey, atRestReady } from "../at-rest/key.js";
import { openLegacySource } from "../legacy-transfer.js";
import { storageWritesHalted } from "../storage-halt.js";
import { PASSWORD_HISTORY_DATABASE } from "../storage-ownership.js";
import {
  DIGESTS,
  idbReq,
  openDigest,
} from "../vault/password-history-legacy.js";

export type LegacyDigest = { scope: string; digest: string };

/**
 * Every digest the sealed database holds, opened, for moving into the
 * encrypted one; undefined when there is nothing to move or it cannot be
 * opened (no durable key, no database).
 */
export async function readLegacyDigests(): Promise<LegacyDigest[] | undefined> {
  if (storageWritesHalted()) return undefined;
  try {
    const atRest = await atRestReady();
    if (!atRest.durable) return undefined;
    const db = await openLegacySource(PASSWORD_HISTORY_DATABASE);
    if (!db) return undefined;
    try {
      return readLegacyDigestsFrom(db, atRest);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export async function readLegacyDigestsFrom(
  db: IDBDatabase,
  atRest: AtRestKey,
): Promise<LegacyDigest[]> {
  const rows: BoundaryValue[] = await idbReq(
    db.transaction(DIGESTS, "readonly").objectStore(DIGESTS).getAll(),
  );
  const out: LegacyDigest[] = [];
  for (const row of rows) {
    const digest = openDigest(atRest, row);
    if (digest !== null && isJsonObject(row) && isString(row.scope)) {
      out.push({ scope: row.scope, digest });
    }
  }
  return out;
}
