/**
 * The two IndexedDB shapes an encrypted database ever has (ADR 0173): one
 * object store of out-of-line keys, and one multi-entry index over every
 * entry of every row. Nothing else about the application's data model is
 * visible in the browser's database, because nothing else is in it.
 */

import {
  type BoundaryValue,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import {
  keyRanges,
  maybeIndexedDatabases,
  openOwnedDatabase,
} from "../../ports.js";
import { haltedWriteError, storageWritesHalted } from "../storage-halt.js";
import type { IndexKey } from "./entries.js";

export const STORE = "r";
export const INDEX = "x";
const VERSION = 1;

export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB failed"));
  });
}

export function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("transaction failed"));
  });
}

/** Open (creating on first use) the database a name pseudonymises. */
export function openDatabase(name: string): Promise<IDBDatabase> {
  // Opening alone recreates a deleted database: a tab whose browser is being
  // reset must not bring one back.
  if (storageWritesHalted()) return Promise.reject(haltedWriteError());
  return new Promise((resolve, reject) => {
    const req = openOwnedDatabase(name, VERSION);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE);
      store.createIndex(INDEX, "x", { multiEntry: true });
    };
    req.onsuccess = () => {
      const db = req.result;
      // An open connection would block a reset from deleting the database.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB failed"));
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}

/** An index entry as the key a range is built from. */
export function keyOf(entry: IndexKey): IDBValidKey {
  return isString(entry) ? entry : [entry[0], entry[1]];
}

export function onlyEntry(entry: IndexKey): IDBKeyRange {
  return keyRanges().only(keyOf(entry));
}

/** The inclusive range between two entries. */
export function betweenEntries(low: IndexKey, high: IndexKey): IDBKeyRange {
  return keyRanges().bound(keyOf(low), keyOf(high));
}

/** Visit a cursor's entries until `visit` says stop or they run out. */
export function walk(
  req: IDBRequest<IDBCursorWithValue | null>,
  visit: (cursor: IDBCursorWithValue) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    req.onerror = () => reject(req.error ?? new Error("IndexedDB failed"));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor === null || !visit(cursor)) resolve();
      else cursor.continue();
    };
  });
}

/** A key this store wrote: always a string, so anything else is not ours. */
export function slotOf(key: IDBValidKey): string | undefined {
  const value: BoundaryValue = overlapCast(key);
  return isString(value) ? value : undefined;
}

/** Delete a database by name; one that is not there counts as deleted. */
export function deleteDatabase(name: string): Promise<void> {
  const factory = maybeIndexedDatabases();
  if (!factory || storageWritesHalted()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const req = factory.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("delete failed"));
    req.onblocked = () => reject(new Error("delete blocked"));
  });
}
