import { bytesToB64 } from "@opensesame/vault-core";
import {
  legacyHistoryStore,
  resetLegacyHistorySweep,
} from "./history-backup-legacy.js";
import type {
  HistoryEntryRecord,
  HistoryRowStore,
  ProvisionalHistoryAccount,
} from "./history-backup-types.js";

export type {
  HistoryAccountClaimState,
  HistoryEntryRecord,
  HistoryRowStore,
  ProvisionalHistoryAccount,
} from "./history-backup-types.js";

/**
 * Store for provisional Postgres-family history accounts and entries.
 * Rows rest in IndexedDB when it is available, and in memory (this document
 * only) when it is not - tests, private mode, a device with no durable
 * at-rest key (ADR 0149). Where they rest in IndexedDB is one of two
 * stores behind `HistoryRowStore`: the device-sealed database, or, while
 * the encrypted-search capability has installed one, an encrypted database
 * in which not even a row's id is readable (ADR 0173).
 */

const memoryAccounts = new Map<string, ProvisionalHistoryAccount>();
const memoryEntries = new Map<string, HistoryEntryRecord>();
let installed: HistoryRowStore | null = null;

/** The store rows rest in: the encrypted one while it is installed. */
function store(): HistoryRowStore {
  return installed ?? legacyHistoryStore;
}

/** Route rows to `next`, or back to the device-sealed database with null. */
export function installHistoryRowStore(next: HistoryRowStore | null): void {
  installed = next;
}

export function resetHistoryBackupMemory(): void {
  memoryAccounts.clear();
  memoryEntries.clear();
  resetLegacyHistorySweep();
}

export function randomHistoryId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

export async function putHistoryAccount(
  account: ProvisionalHistoryAccount,
): Promise<void> {
  const persisted = await store().putAccount(account);
  if (persisted === true) memoryAccounts.delete(account.id);
  else memoryAccounts.set(account.id, account);
}

export async function getHistoryAccount(
  id: string,
): Promise<ProvisionalHistoryAccount | undefined> {
  return (await store().getAccount(id)) ?? memoryAccounts.get(id);
}

export async function listHistoryAccounts(): Promise<
  ProvisionalHistoryAccount[]
> {
  const rows = await store().listAccounts();
  if (!rows) return [...memoryAccounts.values()];
  const merged = new Map(rows.map((row) => [row.id, row]));
  for (const [id, account] of memoryAccounts) {
    if (!merged.has(id)) merged.set(id, account);
  }
  return [...merged.values()];
}

export async function listHistoryEntries(
  accountId: string,
): Promise<HistoryEntryRecord[]> {
  const rows = await store().listEntries(accountId);
  const memoryRows = [...memoryEntries.values()].filter(
    (row) => row.accountId === accountId,
  );
  if (!rows) return memoryRows;
  const seen = new Set(rows.map((row) => row.id));
  return [...rows, ...memoryRows.filter((row) => !seen.has(row.id))];
}

/** Whether any sealed snapshot is held here, whichever account it belongs to. */
export async function holdsAnyHistoryEntry(): Promise<boolean> {
  return (await store().holdsAnyEntry()) === true || memoryEntries.size > 0;
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
  if ((await store().putEntry(entry)) !== true) {
    memoryEntries.set(entry.id, entry);
  }
  return entry;
}
