import { bytesToB64 } from "@opensesame/vault-core";
import { assertNotDecoySession, withRealAuthority } from "./decoy-session.js";
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
 * in which not even a row's id is readable (ADR 0175).
 */

const memoryAccounts = new Map<string, ProvisionalHistoryAccount>();
const memoryEntries = new Map<string, HistoryEntryRecord>();
let installed: HistoryRowStore | null = null;

let resetLegacySweep: (() => void) | undefined;
let legacySweepResetPending = false;

/** Capture the store before loading its device-sealed fallback. */

async function store(): Promise<HistoryRowStore> {
  const selected = installed;
  if (selected) return selected;
  const legacy = await import("./history-backup-legacy.js");
  resetLegacySweep = legacy.resetLegacyHistorySweep;
  if (legacySweepResetPending) {
    resetLegacySweep();
    legacySweepResetPending = false;
  }
  return legacy.legacyHistoryStore;
}

/** Route rows to `next`, or back to the device-sealed database with null. */
export function installHistoryRowStore(
  next: HistoryRowStore | null,
): () => void {
  installed = next;
  return () => {
    if (installed === next) installed = null;
  };
}

export function resetHistoryBackupMemory(): void {
  memoryAccounts.clear();
  memoryEntries.clear();
  if (resetLegacySweep) resetLegacySweep();
  else legacySweepResetPending = true;
}

export function randomHistoryId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

async function withHistoryRows<T>(
  work: (selected: HistoryRowStore, check: () => void) => Promise<T>,
): Promise<T> {
  return withRealAuthority(async () => {
    const generation = assertNotDecoySession();
    const selected = await store();
    const check = () => {
      assertNotDecoySession(generation);
    };
    check();
    return work(selected, check);
  });
}

export async function putHistoryAccount(
  account: ProvisionalHistoryAccount,
): Promise<void> {
  return withHistoryRows(async (selected, check) => {
    const persisted = await selected.putAccount(account);
    check();
    if (persisted === true) memoryAccounts.delete(account.id);
    else memoryAccounts.set(account.id, account);
  });
}

export async function getHistoryAccount(
  id: string,
): Promise<ProvisionalHistoryAccount | undefined> {
  return withHistoryRows(async (selected, check) => {
    const row = await selected.getAccount(id);
    check();
    return row ?? memoryAccounts.get(id);
  });
}

export async function listHistoryAccounts(): Promise<
  ProvisionalHistoryAccount[]
> {
  return withHistoryRows(async (selected, check) => {
    const rows = await selected.listAccounts();
    check();
    if (!rows) return [...memoryAccounts.values()];
    const merged = new Map(rows.map((row) => [row.id, row]));
    for (const [id, account] of memoryAccounts) {
      if (!merged.has(id)) merged.set(id, account);
    }
    return [...merged.values()];
  });
}

export async function listHistoryEntries(
  accountId: string,
): Promise<HistoryEntryRecord[]> {
  return withHistoryRows(async (selected, check) => {
    const rows = await selected.listEntries(accountId);
    check();
    const memoryRows = [...memoryEntries.values()].filter(
      (row) => row.accountId === accountId,
    );
    if (!rows) return memoryRows;
    const seen = new Set(rows.map((row) => row.id));
    return [...rows, ...memoryRows.filter((row) => !seen.has(row.id))];
  });
}

/** Whether any sealed snapshot is held here, whichever account it belongs to. */
export async function holdsAnyHistoryEntry(): Promise<boolean> {
  return withHistoryRows(async (selected, check) => {
    const held = await selected.holdsAnyEntry();
    check();
    return held === true || memoryEntries.size > 0;
  });
}

export async function appendHistoryEntry(
  accountId: string,
  ciphertext: Uint8Array,
): Promise<HistoryEntryRecord> {
  return withHistoryRows(async (selected, check) => {
    const entry: HistoryEntryRecord = {
      id: randomHistoryId("hent"),
      accountId,
      ciphertextB64: bytesToB64(ciphertext),
      createdAt: new Date().toISOString(),
    };
    const persisted = await selected.putEntry(entry);
    check();
    if (persisted !== true) memoryEntries.set(entry.id, entry);
    return entry;
  });
}
