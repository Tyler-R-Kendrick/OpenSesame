/**
 * Multi-select history backups over git remotes.
 *
 * Selections reuse Host connectors (GitHub / GitLab / Bitbucket / Codeberg / Origin / generic git /
 * password-store).
 */

import { isString } from "@opensesame/os-domain";
import {
  type CapabilityConnectorBinding,
  type HistoryBackupGroup,
  type HistoryBackupSelection,
  connectorLabel,
} from "./capabilities.js";
import {
  type ProvisionalHistoryAccount,
  listHistoryAccounts,
  putHistoryAccount,
} from "./history-backup-idb.js";
import { loadSettings, saveSettings } from "./settings.js";

export type { HistoryBackupGroup, HistoryBackupSelection };
export type {
  HistoryAccountClaimState,
  HistoryEntryRecord,
  ProvisionalHistoryAccount,
} from "./history-backup-idb.js";
export {
  getHistoryAccount,
  listHistoryAccounts,
  listHistoryEntries,
} from "./history-backup-idb.js";

export type HistoryBackupGroupDef = {
  id: HistoryBackupGroup;
  title: string;
  providerIds: readonly string[];
};

export const HISTORY_BACKUP_GROUPS: readonly HistoryBackupGroupDef[] = [
  {
    id: "git",
    title: "Git",
    providerIds: [
      "github",
      "password-store",
      "gitlab",
      "bitbucket",
      "codeberg",
      "origin",
      "git",
    ],
  },
];

export function historyRequiresHostAuth(providerId: string): boolean {
  return (
    providerId === "github" ||
    providerId === "gitlab" ||
    providerId === "bitbucket" ||
    providerId === "codeberg" ||
    providerId === "origin"
  );
}

export function normalizeHistorySelections(
  binding: CapabilityConnectorBinding | null | undefined,
): HistoryBackupSelection[] {
  // An explicit `selections` array wins — including `[]` after the last
  // provider is toggled off. Only legacy bindings without `selections` fall
  // through to the single-provider default.
  if (Array.isArray(binding?.selections)) {
    const out: HistoryBackupSelection[] = [];
    for (const raw of binding.selections) {
      if (!isString(raw.providerId) || !raw.providerId.trim()) continue;
      const git = HISTORY_BACKUP_GROUPS[0];
      if (!git?.providerIds.includes(raw.providerId)) continue;
      const next: HistoryBackupSelection = {
        providerId: raw.providerId,
        group: "git",
      };
      if (isString(raw.connectionId) && raw.connectionId.trim()) {
        next.connectionId = raw.connectionId.trim();
      }
      if (isString(raw.remote) && raw.remote.trim()) {
        next.remote = raw.remote.trim();
      }
      if (raw.claimState === "provisional" || raw.claimState === "claimed") {
        next.claimState = raw.claimState;
      }
      if (
        isString(raw.provisionalAccountId) &&
        raw.provisionalAccountId.trim()
      ) {
        next.provisionalAccountId = raw.provisionalAccountId.trim();
      }
      out.push(next);
    }
    return out;
  }
  const providerId = binding?.providerId?.trim() || "github";
  const selection: HistoryBackupSelection = {
    providerId,
    group: "git",
  };
  if (binding?.connectionId) selection.connectionId = binding.connectionId;
  if (binding?.remote) selection.remote = binding.remote;
  return [selection];
}

function persistHistoryBinding(selections: HistoryBackupSelection[]): void {
  const current = loadSettings();
  const primary = selections[0];
  const next: CapabilityConnectorBinding = {
    // Keep a stable providerId for legacy readers; empty selections stay empty.
    providerId: primary?.providerId ?? "github",
    selections,
  };
  if (primary?.connectionId) next.connectionId = primary.connectionId;
  if (primary?.remote) next.remote = primary.remote;
  saveSettings({
    ...current,
    capabilityConnectors: {
      ...current.capabilityConnectors,
      history: next,
    },
  });
}

export function loadHistorySelections(): HistoryBackupSelection[] {
  return normalizeHistorySelections(
    loadSettings().capabilityConnectors.history,
  );
}

export function isHistorySelected(providerId: string): boolean {
  return loadHistorySelections().some((row) => row.providerId === providerId);
}

/** Toggle a git remote in or out of the history backup selection. */
export async function toggleHistoryProvider(
  providerId: string,
): Promise<HistoryBackupSelection[]> {
  const providers = HISTORY_BACKUP_GROUPS[0]?.providerIds ?? [];
  if (!providers.includes(providerId)) {
    throw new Error(`unknown history provider ${providerId}`);
  }
  const current = loadHistorySelections();
  const existing = current.find((row) => row.providerId === providerId);
  if (existing) {
    persistHistoryBinding(
      current.filter((row) => row.providerId !== providerId),
    );
    return loadHistorySelections();
  }
  const selection: HistoryBackupSelection = { providerId, group: "git" };
  persistHistoryBinding([...current, selection]);
  return loadHistorySelections();
}

export function bindHistoryConnection(
  providerId: string,
  connectionId: string,
  remote?: string,
): void {
  const selections = loadHistorySelections().map((row) => {
    if (row.providerId !== providerId) return row;
    const next: HistoryBackupSelection = {
      providerId: row.providerId,
      group: row.group,
      connectionId,
    };
    if (row.remote) next.remote = row.remote;
    if (row.claimState) next.claimState = row.claimState;
    if (row.provisionalAccountId) {
      next.provisionalAccountId = row.provisionalAccountId;
    }
    if (remote?.trim()) next.remote = remote.trim();
    return next;
  });
  persistHistoryBinding(selections);
}

/**
 * Persist a sealed history blob to every selected Postgres anon account.
 * Returns how many accounts accepted the write.
 */
/**
 * Promote provisional anon history accounts onto a claimed principal.
 * Called when a guest finishes registered sign-in.
 */
export async function claimProvisionalHistoryAccounts(
  principalId: string,
): Promise<number> {
  const accounts = await listHistoryAccounts();
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

export function historyBackupSummary(
  selections: HistoryBackupSelection[] = loadHistorySelections(),
): string {
  if (selections.length === 0) return "No backups selected";
  return selections.map((row) => connectorLabel(row.providerId)).join(", ");
}

/** Count of provisional Postgres anon accounts waiting on guest claim. */
export async function countProvisionalHistoryAccounts(): Promise<number> {
  const accounts = await listHistoryAccounts();
  return accounts.filter((row) => row.claimState === "provisional").length;
}
