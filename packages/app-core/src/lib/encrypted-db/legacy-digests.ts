/**
 * Reading the device-sealed digest database for the move into the encrypted
 * one (ADR 0173). Lives with the optional library, not the store it reads, so
 * the core entry carries none of it.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { openOwnedDatabase } from "../../ports.js";
import { atRestReady } from "../at-rest/key.js";
import { storageWritesHalted } from "../storage-halt.js";
import { PASSWORD_HISTORY_DATABASE } from "../storage-ownership.js";
import {
  DB_VERSION,
  DIGESTS,
  idbReq,
  openDigest,
} from "../vault/password-history-legacy.js";

/** Open the database only if it exists: opening alone would create it. */
function openExisting(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve, reject) => {
    const req = openOwnedDatabase(PASSWORD_HISTORY_DATABASE, DB_VERSION);
    let created = false;
    req.onupgradeneeded = (event) => {
      if (event.oldVersion !== 0) return;
      created = true;
      req.transaction?.abort();
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      created
        ? resolve(undefined)
        : reject(req.error ?? new Error("indexedDB open failed"));
  });
}

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
    const db = await openExisting();
    if (!db) return undefined;
    try {
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
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}
