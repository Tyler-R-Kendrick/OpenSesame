import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { bytesToB64 } from "@opensesame/vault-core";
import { openOwnedDatabase } from "../ports.js";
import { atRestBinding, openAtRest, sealAtRest } from "./at-rest/cipher.js";
import { type AtRestKey, atRestReady } from "./at-rest/key.js";
import { storageWritesHalted } from "./storage-halt.js";
import { HISTORY_BACKUP_DATABASE } from "./storage-ownership.js";

/**
 * Store for provisional Postgres-family history accounts and entries.
 * Uses IndexedDB when available; falls back to memory (tests / private mode).
 * Every row is sealed under the device's at-rest key (ADR 0148): only its
 * random id — and an entry's random account id, which the index needs —
 * stays readable. With no durable key nothing reaches IndexedDB.
 */

export type HistoryAccountClaimState = "provisional" | "claimed";

export type ProvisionalHistoryAccount = {
  id: string;
  providerId: string;
  /** Opaque anon/agent credential handle — never a user password. */
  anonToken: string;
  claimState: HistoryAccountClaimState;
  principalId?: string;
  createdAt: string;
  claimedAt?: string;
};

export type HistoryEntryRecord = {
  id: string;
  accountId: string;
  /** Sealed snapshot bytes as base64. */
  ciphertextB64: string;
  createdAt: string;
};

const DB_VERSION = 1;
const ACCOUNTS = "accounts";
const ENTRIES = "entries";

const memoryAccounts = new Map<string, ProvisionalHistoryAccount>();
let legacySwept = false;
const memoryEntries = new Map<string, HistoryEntryRecord>();

export function resetHistoryBackupMemory(): void {
  memoryAccounts.clear();
  memoryEntries.clear();
  legacySwept = false;
}

export function randomHistoryId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
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

function idbReq<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("indexedDB request failed"));
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
function openRow(
  atRest: AtRestKey,
  store: string,
  row: BoundaryValue,
): BoundaryValue {
  if (!isJsonObject(row) || !isString(row.id)) return null;
  if (!isString(row.sealed)) return row;
  const text = openAtRest(atRest.key, rowBinding(store, row.id), row.sealed);
  if (text === null) return null;
  try {
    const record: BoundaryValue = JSON.parse(text);
    return isJsonObject(record) && record.id === row.id ? record : null;
  } catch {
    return null;
  }
}

function asAccount(value: BoundaryValue): ProvisionalHistoryAccount | null {
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

function asEntry(value: BoundaryValue): HistoryEntryRecord | null {
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

function present<T>(value: T | null): value is T {
  return value !== null;
}

/** Seal, once per document, any row written before rows were sealed. */
async function sealLegacyRows(db: IDBDatabase, atRest: AtRestKey) {
  if (legacySwept) return;
  legacySwept = true;
  const tx = db.transaction([ACCOUNTS, ENTRIES], "readwrite");
  for (const store of [ACCOUNTS, ENTRIES]) {
    const rows: BoundaryValue[] = await idbReq(tx.objectStore(store).getAll());
    for (const row of rows) {
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
        // Unreadable to the app either way; not left in the clear.
        await idbReq(tx.objectStore(store).delete(row.id));
      }
    }
  }
}

async function withDb<T>(
  run: (db: IDBDatabase, atRest: AtRestKey) => Promise<T>,
): Promise<T | undefined> {
  // Opening alone recreates a deleted database, so a tab whose browser is
  // being reset does not open it at all; memory answers until it reloads.
  if (storageWritesHalted()) return undefined;
  try {
    const atRest = await atRestReady();
    // A key that dies with this document: rows could never be read back.
    if (!atRest.durable) return undefined;
    const db = await openDb();
    try {
      await sealLegacyRows(db, atRest);
      return await run(db, atRest);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export async function putHistoryAccount(
  account: ProvisionalHistoryAccount,
): Promise<void> {
  memoryAccounts.set(account.id, account);
  await withDb(async (db, atRest) => {
    const tx = db.transaction(ACCOUNTS, "readwrite");
    await idbReq(
      tx.objectStore(ACCOUNTS).put(sealRow(atRest, ACCOUNTS, account)),
    );
  });
}

export async function getHistoryAccount(
  id: string,
): Promise<ProvisionalHistoryAccount | undefined> {
  const row = await withDb(async (db, atRest) => {
    const tx = db.transaction(ACCOUNTS, "readonly");
    const stored: BoundaryValue = await idbReq(
      tx.objectStore(ACCOUNTS).get(id),
    );
    return asAccount(openRow(atRest, ACCOUNTS, stored ?? null));
  });
  return row ?? memoryAccounts.get(id);
}

export async function listHistoryAccounts(): Promise<
  ProvisionalHistoryAccount[]
> {
  const rows = await withDb(async (db, atRest) => {
    const tx = db.transaction(ACCOUNTS, "readonly");
    const stored: BoundaryValue[] = await idbReq(
      tx.objectStore(ACCOUNTS).getAll(),
    );
    return stored
      .map((row) => asAccount(openRow(atRest, ACCOUNTS, row)))
      .filter(present);
  });
  return rows ?? [...memoryAccounts.values()];
}

export async function listHistoryEntries(
  accountId: string,
): Promise<HistoryEntryRecord[]> {
  const rows = await withDb(async (db, atRest) => {
    const tx = db.transaction(ENTRIES, "readonly");
    const index = tx.objectStore(ENTRIES).index("by_account");
    const stored: BoundaryValue[] = await idbReq(index.getAll(accountId));
    return stored
      .map((row) => asEntry(openRow(atRest, ENTRIES, row)))
      .filter(present);
  });
  if (rows) return rows;
  return [...memoryEntries.values()].filter(
    (row) => row.accountId === accountId,
  );
}

export async function appendHistoryEntry(
  accountId: string,
  ciphertext: Uint8Array,
): Promise<HistoryEntryRecord> {
  const entry: HistoryEntryRecord = {
    id: randomHistoryId("hent"),
    accountId,
    ciphertextB64: bytesToB64(ciphertext),
    createdAt: new Date().toISOString(),
  };
  memoryEntries.set(entry.id, entry);
  await withDb(async (db, atRest) => {
    const tx = db.transaction(ENTRIES, "readwrite");
    await idbReq(
      tx.objectStore(ENTRIES).put(sealRow(atRest, ENTRIES, entry, accountId)),
    );
  });
  return entry;
}
