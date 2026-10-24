/** Synchronous store selection and row custody; legacy encryption/migration loads on an actual action. */
import { bytesToB64 } from "@opensesame/vault-core";
import { maybeIndexedDatabases } from "../ports.js";
import { atRestReady, atRestSettled } from "./at-rest/key.js";
import type {
  HistoryEntryRecord,
  HistoryRowStore,
  ProvisionalHistoryAccount,
} from "./history-backup-types.js";
import { storageWritesHalted } from "./storage-halt.js";
export type {
  HistoryAccountClaimState,
  HistoryEntryRecord,
  HistoryRowStore,
  ProvisionalHistoryAccount,
} from "./history-backup-types.js";

const memoryAccounts = new Map<string, ProvisionalHistoryAccount>();
const memoryEntries = new Map<string, HistoryEntryRecord>();
let installed: HistoryRowStore | null = null;
let generation = 0;
let resetOnLoad = false;
let runtime: Promise<typeof import("./history-backups-runtime.js")> | undefined;
let loaded: typeof import("./history-backups-runtime.js") | undefined;

/** Code loading only; never selects a store, key, destination, or permission. */
export const historyActionLoading = {
  load: () => import("./history-backups-runtime.js"),
};

export function loadHistoryActions() {
  const load = historyActionLoading.load;
  runtime ??= load().then(
    (next) => {
      loaded = next;
      if (resetOnLoad) {
        next.resetLegacyHistorySweep();
        resetOnLoad = false;
      }
      return next;
    },
    (error) => {
      runtime = undefined;
      throw error;
    },
  );
  return runtime;
}
function originalKey() {
  try {
    return atRestReady().catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}
function originalDatabase() {
  try {
    return maybeIndexedDatabases();
  } catch {
    return undefined;
  }
}
type Owner = ReturnType<typeof capture>;
function capture() {
  const driver = installed;
  const halted = driver === null && storageWritesHalted();
  return {
    driver,
    generation,
    halted,
    // Match the legacy operation's original first await; no later key is adopted.
    key: driver || halted ? null : originalKey(),
    database: driver || halted ? undefined : originalDatabase(),
  };
}
function check(owner: Owner): void {
  if (owner.generation !== generation)
    throw new Error("This history storage operation ended.");
}
function checkLegacy(
  owner: Owner,
  key: Awaited<ReturnType<typeof originalKey>>,
) {
  check(owner);
  if (atRestSettled() !== key || originalDatabase() !== owner.database)
    throw new Error("This history storage operation ended.");
}
async function legacy(owner: Owner) {
  if (!owner.key) return undefined;
  const key = await owner.key;
  check(owner);
  if (!key?.durable || owner.halted || storageWritesHalted()) return undefined;
  const action = await loadHistoryActions();
  checkLegacy(owner, key);
  if (storageWritesHalted()) return undefined;
  return {
    key,
    store: action.bindLegacyHistoryStore(() => checkLegacy(owner, key)),
  };
}

function run<T>(
  owner: Owner,
  operation: (store: HistoryRowStore) => Promise<T>,
) {
  check(owner);
  // Installed driver calls still begin synchronously before their first await.
  if (owner.driver) return operation(owner.driver);
  return legacy(owner).then((selected) => {
    check(owner);
    if (!selected) return undefined;
    // This is the exact synchronous handoff to the selected delegate, after
    // the resolver-to-reaction microtask; its bound store fences its own I/O awaits.
    checkLegacy(owner, selected.key);
    if (storageWritesHalted()) return undefined;
    return operation(selected.store);
  });
}
/** Route future operations only; a held action retains its originally selected store. */
export function installHistoryRowStore(next: HistoryRowStore | null): void {
  installed = next;
}
export function resetHistoryBackupMemory(): void {
  generation += 1;
  memoryAccounts.clear();
  memoryEntries.clear();
  if (loaded) loaded.resetLegacyHistorySweep();
  else resetOnLoad = true;
}
export function randomHistoryId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}
async function putAccount(account: ProvisionalHistoryAccount, owner: Owner) {
  const captured = { ...account };
  const persisted = await run(owner, (store) => store.putAccount(captured));
  check(owner);
  if (persisted === true) memoryAccounts.delete(captured.id);
  else memoryAccounts.set(captured.id, captured);
}
export function putHistoryAccount(
  account: ProvisionalHistoryAccount,
): Promise<void> {
  return putAccount(account, capture());
}
export async function getHistoryAccount(
  id: string,
): Promise<ProvisionalHistoryAccount | undefined> {
  const owner = capture();
  const account = await run(owner, (store) => store.getAccount(id));
  check(owner);
  return account ?? memoryAccounts.get(id);
}
async function listAccounts(
  owner: Owner,
): Promise<ProvisionalHistoryAccount[]> {
  const rows = await run(owner, (store) => store.listAccounts());
  check(owner);
  if (!rows) return [...memoryAccounts.values()];
  const merged = new Map(rows.map((row) => [row.id, row]));
  for (const [id, account] of memoryAccounts) {
    if (!merged.has(id)) merged.set(id, account);
  }
  return [...merged.values()];
}
export function listHistoryAccounts(): Promise<ProvisionalHistoryAccount[]> {
  return listAccounts(capture());
}
/** One claim action keeps the store/lifetime it selected before loading implementation code. */
export function captureHistoryRows() {
  const owner = capture();
  return {
    assertCurrent: () => check(owner),
    listAccounts: () =>
      listAccounts(owner).then((rows) => rows.map((row) => ({ ...row }))),
    putAccount: (account: ProvisionalHistoryAccount) =>
      putAccount(account, owner),
  };
}
export async function listHistoryEntries(
  accountId: string,
): Promise<HistoryEntryRecord[]> {
  const owner = capture();
  const rows = await run(owner, (store) => store.listEntries(accountId));
  check(owner);
  const memoryRows = [...memoryEntries.values()].filter(
    (row) => row.accountId === accountId,
  );
  if (!rows) return memoryRows;
  const seen = new Set(rows.map((row) => row.id));
  return [...rows, ...memoryRows.filter((row) => !seen.has(row.id))];
}
export async function holdsAnyHistoryEntry(): Promise<boolean> {
  const owner = capture();
  const held = await run(owner, (store) => store.holdsAnyEntry());
  check(owner);
  return held === true || memoryEntries.size > 0;
}
export async function appendHistoryEntry(
  accountId: string,
  ciphertext: Uint8Array,
): Promise<HistoryEntryRecord> {
  const owner = capture();
  const entry: HistoryEntryRecord = {
    id: randomHistoryId("hent"),
    accountId,
    ciphertextB64: bytesToB64(ciphertext),
    createdAt: new Date().toISOString(),
  };
  const persisted = await run(owner, (store) => store.putEntry(entry));
  check(owner);
  if (persisted !== true) memoryEntries.set(entry.id, entry);
  return entry;
}
