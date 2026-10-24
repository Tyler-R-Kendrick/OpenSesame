import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { maybeIndexedDatabases, openOwnedDatabase } from "../ports.js";
import { atRestBinding, openAtRest, sealAtRest } from "./at-rest/cipher.js";
import { type AtRestKey, atRestReady, atRestSettled } from "./at-rest/key.js";
import type {
  HistoryEntryRecord,
  HistoryRowStore,
  ProvisionalHistoryAccount,
} from "./history-backup-types.js";
import { storageWritesHalted } from "./storage-halt.js";
import { HISTORY_BACKUP_DATABASE } from "./storage-ownership.js";

/**
 * The history store as it was before encrypted search (ADR 0149): one
 * IndexedDB database of two stores, every row sealed under the device's
 * at-rest key. Only a row's random id - and an entry's account id, which
 * the index needs - stays readable, and the database, store and index names
 * are plain. With no durable key nothing reaches IndexedDB.
 */

export const DB_VERSION = 1;
export const ACCOUNTS = "accounts";
export const ENTRIES = "entries";

let legacySwept = false;
let legacySweep: Promise<void> | null = null;

export function resetLegacyHistorySweep(): void {
  legacySwept = false;
  legacySweep = null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = openOwnedDatabase(HISTORY_BACKUP_DATABASE, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ACCOUNTS)) {
        db.createObjectStore(ACCOUNTS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(ENTRIES)) {
        const store = db.createObjectStore(ENTRIES, { keyPath: "id" });
        store.createIndex("by_account", "accountId", { unique: false });
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

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error ?? new Error("indexedDB transaction aborted"));
    tx.onerror = () =>
      reject(tx.error ?? new Error("indexedDB transaction failed"));
  });
}

type SealedRow = { id: string; accountId?: string; sealed: string };

function rowBinding(store: string, id: string): Uint8Array {
  return atRestBinding(`idb.${HISTORY_BACKUP_DATABASE}.${store}`, id);
}

function sealRow(
  atRest: AtRestKey,
  store: string,
  record: ProvisionalHistoryAccount | HistoryEntryRecord,
  accountId?: string,
): SealedRow {
  const sealed = sealAtRest(
    atRest.key,
    rowBinding(store, record.id),
    JSON.stringify(record),
  );
  return accountId === undefined
    ? { id: record.id, sealed }
    : { id: record.id, accountId, sealed };
}

/** A row's record: opened when sealed, as stored when written before sealing. */
export function openRow(
  atRest: AtRestKey,
  store: string,
  row: BoundaryValue,
  allowLegacyPlaintext = true,
): BoundaryValue {
  if (!isJsonObject(row) || !isString(row.id)) return null;
  if (!isString(row.sealed)) return allowLegacyPlaintext ? row : null;
  const text = openAtRest(atRest.key, rowBinding(store, row.id), row.sealed);
  if (text === null) return null;
  try {
    const record: BoundaryValue = JSON.parse(text);
    return isJsonObject(record) && record.id === row.id ? record : null;
  } catch {
    return null;
  }
}

export function asAccount(
  value: BoundaryValue,
): ProvisionalHistoryAccount | null {
  if (
    !isJsonObject(value) ||
    !isString(value.id) ||
    !isString(value.providerId) ||
    !isString(value.anonToken) ||
    (value.claimState !== "provisional" && value.claimState !== "claimed") ||
    !isString(value.createdAt)
  ) {
    return null;
  }
  const account: ProvisionalHistoryAccount = {
    id: value.id,
    providerId: value.providerId,
    anonToken: value.anonToken,
    claimState: value.claimState,
    createdAt: value.createdAt,
  };
  if (isString(value.principalId)) account.principalId = value.principalId;
  if (isString(value.claimedAt)) account.claimedAt = value.claimedAt;
  return account;
}

export function asEntry(value: BoundaryValue): HistoryEntryRecord | null {
  if (
    !isJsonObject(value) ||
    !isString(value.id) ||
    !isString(value.accountId) ||
    !isString(value.ciphertextB64) ||
    !isString(value.createdAt)
  ) {
    return null;
  }
  return {
    id: value.id,
    accountId: value.accountId,
    ciphertextB64: value.ciphertextB64,
    createdAt: value.createdAt,
  };
}

export function present<T>(value: T | null): value is T {
  return value !== null;
}

/** Seal, once per document, any row written before rows were sealed. */
async function sealLegacyRows(
  db: IDBDatabase,
  atRest: AtRestKey,
  check?: () => void,
) {
  check?.();
  if (legacySwept) return;
  if (legacySweep) return legacySweep;
  const sweep = (async () => {
    const tx = db.transaction([ACCOUNTS, ENTRIES], "readwrite");
    const done = txDone(tx);
    // An earlier request may reject before the loop awaits transaction completion.
    void done.catch(() => undefined);
    try {
      for (const store of [ACCOUNTS, ENTRIES]) {
        const rows: BoundaryValue[] = await idbReq(
          tx.objectStore(store).getAll(),
        );
        check?.();
        for (const row of rows) {
          check?.();
          if (!isJsonObject(row) || isString(row.sealed)) continue;
          const account = store === ACCOUNTS ? asAccount(row) : null;
          const entry = store === ENTRIES ? asEntry(row) : null;
          if (account) {
            await idbReq(
              tx.objectStore(store).put(sealRow(atRest, store, account)),
            );
          } else if (entry) {
            const sealed = sealRow(atRest, store, entry, entry.accountId);
            await idbReq(tx.objectStore(store).put(sealed));
          } else if (isString(row.id)) {
            // Unreadable to the app either way: sealed whole rather than dropped
            // or left in the clear.
            const sealed = sealAtRest(
              atRest.key,
              rowBinding(store, row.id),
              JSON.stringify(row),
            );
            await idbReq(tx.objectStore(store).put({ id: row.id, sealed }));
          }
        }
      }
      await done;
      check?.();
      // Latch only after every row and the transaction committed. A transient
      // IndexedDB failure leaves the next call free to retry.
      legacySwept = true;
    } finally {
      legacySweep = null;
    }
  })();
  legacySweep = sweep;
  return sweep;
}

type BoundLegacyOwner = Readonly<{ key: AtRestKey; active: () => void }>;

/** Capture current storage custody only; this callback supplies cancellation, never new authority. */
export function bindLegacyHistoryStore(check: () => void): HistoryRowStore {
  check();
  const key = atRestSettled();
  const database = maybeIndexedDatabases();
  if (!key?.durable)
    throw new Error("Original history storage key is unavailable.");
  const active = () => {
    check();
    if (
      atRestSettled() !== key ||
      maybeIndexedDatabases() !== database ||
      storageWritesHalted()
    )
      throw new Error("This history storage operation ended.");
  };
  active();
  return makeHistoryStore({ key, active });
}

function checkLegacyOwner(bound: BoundLegacyOwner | undefined): void {
  bound?.active();
}

async function withLegacyDatabase<T>(
  bound: BoundLegacyOwner | undefined,
  run: (db: IDBDatabase, atRest: AtRestKey) => Promise<T>,
): Promise<T | undefined> {
  // Opening alone recreates a deleted database, so a tab whose browser is
  // being reset does not open it at all; memory answers until it reloads.
  checkLegacyOwner(bound);
  if (storageWritesHalted()) return undefined;
  let atRest: AtRestKey;
  try {
    atRest = bound?.key ?? (await atRestReady());
  } catch {
    return undefined;
  }
  checkLegacyOwner(bound);
  // A key that dies with this document: rows could never be read back.
  if (!atRest.durable) return undefined;
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    checkLegacyOwner(bound);
    return undefined;
  }
  try {
    checkLegacyOwner(bound);
    try {
      await sealLegacyRows(db, atRest, bound?.active);
    } catch {
      checkLegacyOwner(bound);
      // A failed sweep is a memory-fallback write, not a rejected history
      // operation; the next call retries the sweep.
      return undefined;
    }
    checkLegacyOwner(bound);
    const result = await run(db, atRest);
    checkLegacyOwner(bound);
    return result;
  } finally {
    db.close();
  }
}

function makeHistoryStore(bound?: BoundLegacyOwner): HistoryRowStore {
  const withDb = <T>(run: (db: IDBDatabase, atRest: AtRestKey) => Promise<T>) =>
    withLegacyDatabase(bound, run);

  return {
    putAccount: (account) =>
      withDb(async (db, atRest) => {
        const tx = db.transaction(ACCOUNTS, "readwrite");
        const done = txDone(tx);
        await idbReq(
          tx.objectStore(ACCOUNTS).put(sealRow(atRest, ACCOUNTS, account)),
        );
        await done;
        return true as const;
      }),

    getAccount: async (id) => {
      const row = await withDb(async (db, atRest) => {
        const tx = db.transaction(ACCOUNTS, "readonly");
        const stored: BoundaryValue = await idbReq(
          tx.objectStore(ACCOUNTS).get(id),
        );
        return asAccount(openRow(atRest, ACCOUNTS, stored ?? null));
      });
      return row ?? undefined;
    },

    listAccounts: () =>
      withDb(async (db, atRest) => {
        const tx = db.transaction(ACCOUNTS, "readonly");
        const stored: BoundaryValue[] = await idbReq(
          tx.objectStore(ACCOUNTS).getAll(),
        );
        return stored
          .map((row) => asAccount(openRow(atRest, ACCOUNTS, row)))
          .filter(present);
      }),

    listEntries: (accountId) =>
      withDb(async (db, atRest) => {
        const tx = db.transaction(ENTRIES, "readonly");
        const index = tx.objectStore(ENTRIES).index("by_account");
        const stored: BoundaryValue[] = await idbReq(index.getAll(accountId));
        return stored
          .map((row) => asEntry(openRow(atRest, ENTRIES, row)))
          .filter(present);
      }),

    holdsAnyEntry: () =>
      withDb(async (db) => {
        const tx = db.transaction(ENTRIES, "readonly");
        return (await idbReq(tx.objectStore(ENTRIES).count())) > 0;
      }),

    putEntry: (entry) =>
      withDb(async (db, atRest) => {
        const tx = db.transaction(ENTRIES, "readwrite");
        const done = txDone(tx);
        await idbReq(
          tx
            .objectStore(ENTRIES)
            .put(sealRow(atRest, ENTRIES, entry, entry.accountId)),
        );
        await done;
        return true as const;
      }),
  };
}

/** The legacy rows, answered through the same seam the encrypted store uses. */
export const legacyHistoryStore: HistoryRowStore = makeHistoryStore();
