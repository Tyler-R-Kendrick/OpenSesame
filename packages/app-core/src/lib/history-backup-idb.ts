import { bytesToB64 } from "@opensesame/vault-core";
import { indexedDatabases } from "../ports.js";

/**
 * Store for provisional Postgres-family history accounts and entries.
 * Uses IndexedDB when available; falls back to memory (tests / private mode).
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

const DB_NAME = "opensesame-history-backups";
const DB_VERSION = 1;
const ACCOUNTS = "accounts";
const ENTRIES = "entries";

const memoryAccounts = new Map<string, ProvisionalHistoryAccount>();
const memoryEntries = new Map<string, HistoryEntryRecord>();

export function resetHistoryBackupMemory(): void {
  memoryAccounts.clear();
  memoryEntries.clear();
}

export function randomHistoryId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDatabases().open(DB_NAME, DB_VERSION);
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

async function withDb<T>(
  run: (db: IDBDatabase) => Promise<T>,
): Promise<T | undefined> {
  try {
    const db = await openDb();
    try {
      return await run(db);
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
  await withDb(async (db) => {
    const tx = db.transaction(ACCOUNTS, "readwrite");
    await idbReq(tx.objectStore(ACCOUNTS).put(account));
  });
}

export async function getHistoryAccount(
  id: string,
): Promise<ProvisionalHistoryAccount | undefined> {
  const row = await withDb(async (db) => {
    const tx = db.transaction(ACCOUNTS, "readonly");
    return idbReq(tx.objectStore(ACCOUNTS).get(id));
  });
  return row ?? memoryAccounts.get(id);
}

export async function listHistoryAccounts(): Promise<
  ProvisionalHistoryAccount[]
> {
  const rows = await withDb(async (db) => {
    const tx = db.transaction(ACCOUNTS, "readonly");
    return idbReq(tx.objectStore(ACCOUNTS).getAll());
  });
  return rows ?? [...memoryAccounts.values()];
}

export async function listHistoryEntries(
  accountId: string,
): Promise<HistoryEntryRecord[]> {
  const rows = await withDb(async (db) => {
    const tx = db.transaction(ENTRIES, "readonly");
    const index = tx.objectStore(ENTRIES).index("by_account");
    return idbReq(index.getAll(accountId));
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
  await withDb(async (db) => {
    const tx = db.transaction(ENTRIES, "readwrite");
    await idbReq(tx.objectStore(ENTRIES).put(entry));
  });
  return entry;
}
