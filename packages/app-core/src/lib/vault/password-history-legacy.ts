import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { openOwnedDatabase } from "../../ports.js";
import { atRestBinding, openAtRest, sealAtRest } from "../at-rest/cipher.js";
import { type AtRestKey, atRestReady } from "../at-rest/key.js";
import { storageWritesHalted } from "../storage-halt.js";
import { PASSWORD_HISTORY_DATABASE } from "../storage-ownership.js";
import type { PasswordDigestStore } from "./password-history-types.js";

/**
 * Retired-password digests as they rest without encrypted search (ADR
 * 0149): one IndexedDB database, each digest sealed under the device's
 * at-rest key. The scope - the vault's name and the item's id - stays
 * readable, because the index needs it, as do the database, store and index
 * names. With no durable key nothing reaches IndexedDB.
 */

export const DB_VERSION = 1;
export const DIGESTS = "digests";

export function isDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = openOwnedDatabase(PASSWORD_HISTORY_DATABASE, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DIGESTS)) {
        const store = db.createObjectStore(DIGESTS, { keyPath: "id" });
        store.createIndex("by_scope", "scope", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

export function idbReq<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("indexedDB request failed"));
  });
}

function rowBinding(id: string): Uint8Array {
  return atRestBinding(`idb.${PASSWORD_HISTORY_DATABASE}.${DIGESTS}`, id);
}

async function withDb<T>(
  run: (db: IDBDatabase, atRest: AtRestKey) => Promise<T>,
): Promise<T | undefined> {
  if (storageWritesHalted()) return undefined;
  try {
    const atRest = await atRestReady();
    if (!atRest.durable) return undefined;
    const db = await openDb();
    try {
      return await run(db, atRest);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export function openDigest(
  atRest: AtRestKey,
  row: BoundaryValue,
): string | null {
  if (!isJsonObject(row) || !isString(row.id) || !isString(row.sealed)) {
    return null;
  }
  const text = openAtRest(atRest.key, rowBinding(row.id), row.sealed);
  return text !== null && isDigest(text) ? text : null;
}

export const legacyPasswordDigestStore: PasswordDigestStore = {
  add: (scope, digest) =>
    withDb(async (db, atRest) => {
      const id = crypto.randomUUID();
      const tx = db.transaction(DIGESTS, "readwrite");
      await idbReq(
        tx.objectStore(DIGESTS).put({
          id,
          scope,
          sealed: sealAtRest(atRest.key, rowBinding(id), digest),
        }),
      );
      return true as const;
    }),

  digestsFor: (scope) =>
    withDb(async (db, atRest) => {
      const tx = db.transaction(DIGESTS, "readonly");
      const stored: BoundaryValue[] = await idbReq(
        tx.objectStore(DIGESTS).index("by_scope").getAll(scope),
      );
      return stored
        .map((row) => openDigest(atRest, row))
        .filter((digest): digest is string => digest !== null);
    }),

  forget: (scope) =>
    withDb(async (db) => {
      const store = db.transaction(DIGESTS, "readwrite").objectStore(DIGESTS);
      const keys: IDBValidKey[] = await idbReq(
        store.index("by_scope").getAllKeys(scope),
      );
      for (const key of keys) await idbReq(store.delete(key));
      return keys.length;
    }),
};
