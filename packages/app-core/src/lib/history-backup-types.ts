/**
 * The records a history backup keeps, and the one seam between them and
 * where they rest (`history-backup-idb.ts`). Two stores sit behind it: the
 * device's sealed IndexedDB database (`history-backup-legacy.ts`) and, when
 * the encrypted-search capability is on, an encrypted database that also
 * hides each row's id and its account (`encrypted-db/history-store.ts`,
 * ADR 0173).
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

/**
 * Where history rows rest. A method answers `undefined` when the store
 * cannot be had (no durable key, no IndexedDB, a reset under way): the
 * caller then keeps the row in memory, for this document only.
 */
export type HistoryRowStore = Readonly<{
  putAccount: (account: ProvisionalHistoryAccount) => Promise<true | undefined>;
  getAccount: (id: string) => Promise<ProvisionalHistoryAccount | undefined>;
  listAccounts: () => Promise<ProvisionalHistoryAccount[] | undefined>;
  listEntries: (accountId: string) => Promise<HistoryEntryRecord[] | undefined>;
  holdsAnyEntry: () => Promise<boolean | undefined>;
  putEntry: (entry: HistoryEntryRecord) => Promise<true | undefined>;
}>;
