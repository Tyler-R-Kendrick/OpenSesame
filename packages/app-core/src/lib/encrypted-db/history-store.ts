/**
 * Provisional history accounts and sealed snapshots in an encrypted database
 * (ADR 0173): the row's id, its account, the provider and every timestamp
 * are inside the seal. A snapshot is found by its account through a blind
 * index entry that exists only once someone has asked.
 */

import { isString } from "@opensesame/os-domain";
import type {
  HistoryEntryRecord,
  HistoryRowStore,
  ProvisionalHistoryAccount,
} from "../history-backup-types.js";
import { type EdbRow, defineSchema } from "./schema.js";
import { withEncryptedDb } from "./with-db.js";

export const HISTORY_DATABASE = "history-backups";

export const historySchema = defineSchema({
  accounts: { key: "id" },
  entries: { key: "id", columns: { accountId: { eq: true } } },
});

function accountOf(row: EdbRow): ProvisionalHistoryAccount | undefined {
  const { id, providerId, anonToken, claimState, createdAt } = row;
  if (
    !isString(id) ||
    !isString(providerId) ||
    !isString(anonToken) ||
    (claimState !== "provisional" && claimState !== "claimed") ||
    !isString(createdAt)
  ) {
    return undefined;
  }
  const account: ProvisionalHistoryAccount = {
    id,
    providerId,
    anonToken,
    claimState,
    createdAt,
  };
  if (isString(row.principalId)) account.principalId = row.principalId;
  if (isString(row.claimedAt)) account.claimedAt = row.claimedAt;
  return account;
}

function entryOf(row: EdbRow): HistoryEntryRecord | undefined {
  const { id, accountId, ciphertextB64, createdAt } = row;
  if (
    !isString(id) ||
    !isString(accountId) ||
    !isString(ciphertextB64) ||
    !isString(createdAt)
  ) {
    return undefined;
  }
  return { id, accountId, ciphertextB64, createdAt };
}

function present<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/** `ready` resolves when rows may be read: after a legacy migration has run. */
export function createHistoryStore(
  ready: () => Promise<void> = async () => {},
): HistoryRowStore {
  const run = async <T>(work: Parameters<typeof withEncryptedDb<T>>[2]) => {
    await ready();
    return withEncryptedDb(HISTORY_DATABASE, historySchema, work);
  };
  return {
    putAccount: (account) =>
      run(async (db) => {
        await db.put("accounts", account);
        return true as const;
      }),
    getAccount: async (id) => {
      const row = await run((db) => db.get("accounts", id));
      return row === undefined ? undefined : accountOf(row);
    },
    listAccounts: () =>
      run(async (db) =>
        (await db.all("accounts")).map(accountOf).filter(present),
      ),
    listEntries: (accountId) =>
      run(async (db) =>
        (await db.find("entries", { accountId }))
          .map(entryOf)
          .filter(present)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      ),
    holdsAnyEntry: () =>
      run(
        async (db) => (await db.find("entries", {}, { limit: 1 })).length > 0,
      ),
    putEntry: (entry) =>
      run(async (db) => {
        await db.put("entries", entry);
        return true as const;
      }),
  };
}
