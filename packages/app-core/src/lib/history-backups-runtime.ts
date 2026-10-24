/** Loaded only by an actual history claim or legacy row operation. Metadata never imports this leaf. */
import type { HistoryBackupSelection } from "./capabilities.js";
import type { ProvisionalHistoryAccount } from "./history-backup-types.js";
export {
  bindLegacyHistoryStore,
  legacyHistoryStore,
  resetLegacyHistorySweep,
} from "./history-backup-legacy.js";

export async function claimHistoryAccounts(
  principalId: string,
  accounts: ProvisionalHistoryAccount[],
  putHistoryAccount: (account: ProvisionalHistoryAccount) => Promise<void>,
  loadHistorySelections: () => HistoryBackupSelection[],
  persistHistoryBinding: (selections: HistoryBackupSelection[]) => void,
): Promise<number> {
  let claimed = 0;
  const now = new Date().toISOString();
  for (const account of accounts) {
    if (account.claimState !== "provisional") continue;
    const next: ProvisionalHistoryAccount = {
      id: account.id,
      providerId: account.providerId,
      anonToken: account.anonToken,
      claimState: "claimed",
      principalId,
      createdAt: account.createdAt,
      claimedAt: now,
    };
    await putHistoryAccount(next);
    claimed += 1;
  }
  if (claimed > 0) {
    const selections = loadHistorySelections().map((row) => {
      if (row.group !== "postgres" || !row.provisionalAccountId) return row;
      const next: HistoryBackupSelection = {
        providerId: row.providerId,
        group: row.group,
        claimState: "claimed",
        provisionalAccountId: row.provisionalAccountId,
      };
      if (row.connectionId) next.connectionId = row.connectionId;
      if (row.remote) next.remote = row.remote;
      return next;
    });
    persistHistoryBinding(selections);
  }
  return claimed;
}
