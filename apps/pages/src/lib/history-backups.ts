/**
 * Multi-select history backups: git remotes and Postgres-family stores.
 *
 * Git selections reuse Host connectors (GitHub / GitLab / password-store).
 * Postgres selections (Supabase, Neon, PostgreSQL) mint an anonymous agent
 * account up front so a guest can persist sealed history immediately; claiming
 * the guest session promotes those accounts onto the registered principal.
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
  appendHistoryEntry,
  bytesToB64,
  listHistoryAccounts,
  putHistoryAccount,
  randomHistoryId,
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
    providerIds: ["github", "password-store", "gitlab"],
  },
  {
    id: "postgres",
    title: "PostgreSQL",
    providerIds: ["supabase", "neon", "postgresql"],
  },
] as const;

const POSTGRES_PROVIDERS = new Set(
  HISTORY_BACKUP_GROUPS.find((g) => g.id === "postgres")?.providerIds ?? [],
);

function groupFor(providerId: string): HistoryBackupGroup {
  return POSTGRES_PROVIDERS.has(providerId) ? "postgres" : "git";
}

export function historyProviderLabel(providerId: string): string {
  switch (providerId) {
    case "supabase":
      return "Supabase";
    case "neon":
      return "Neon";
    case "postgresql":
      return "PostgreSQL";
    default:
      return connectorLabel(providerId);
  }
}

export function historyRequiresHostAuth(providerId: string): boolean {
  return providerId === "github" || providerId === "gitlab";
}

export function normalizeHistorySelections(
  binding: CapabilityConnectorBinding | null | undefined,
): HistoryBackupSelection[] {
  if (binding?.selections && binding.selections.length > 0) {
    const out: HistoryBackupSelection[] = [];
    for (const raw of binding.selections) {
      if (!isString(raw.providerId) || !raw.providerId.trim()) continue;
      const group =
        raw.group === "postgres" || raw.group === "git"
          ? raw.group
          : groupFor(raw.providerId);
      const allowed = HISTORY_BACKUP_GROUPS.find((g) => g.id === group);
      if (!allowed?.providerIds.includes(raw.providerId)) continue;
      const next: HistoryBackupSelection = {
        providerId: raw.providerId,
        group,
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
    if (out.length > 0) return out;
  }
  const providerId = binding?.providerId?.trim() || "github";
  const selection: HistoryBackupSelection = {
    providerId,
    group: groupFor(providerId),
  };
  if (binding?.connectionId) selection.connectionId = binding.connectionId;
  if (binding?.remote) selection.remote = binding.remote;
  return [selection];
}

function persistHistoryBinding(selections: HistoryBackupSelection[]): void {
  const current = loadSettings();
  const primary = selections[0] ?? {
    providerId: "github",
    group: "git" as const,
  };
  const next: CapabilityConnectorBinding = {
    providerId: primary.providerId,
    selections,
  };
  if (primary.connectionId) next.connectionId = primary.connectionId;
  if (primary.remote) next.remote = primary.remote;
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

/** Mint an anon/agent account for a Postgres-family backup provider. */
export async function provisionAnonHistoryAccount(
  providerId: string,
): Promise<ProvisionalHistoryAccount> {
  if (!POSTGRES_PROVIDERS.has(providerId)) {
    throw new Error(`${providerId} does not use anon history accounts`);
  }
  const account: ProvisionalHistoryAccount = {
    id: randomHistoryId("hacc"),
    providerId,
    anonToken: bytesToB64(crypto.getRandomValues(new Uint8Array(24))),
    claimState: "provisional",
    createdAt: new Date().toISOString(),
  };
  await putHistoryAccount(account);
  return account;
}

/**
 * Toggle a backup provider in or out of the multi-select. Postgres providers
 * provision an anon account on first select so history can persist before claim.
 */
export async function toggleHistoryProvider(
  providerId: string,
): Promise<HistoryBackupSelection[]> {
  const group = groupFor(providerId);
  const allowed = HISTORY_BACKUP_GROUPS.find((g) => g.id === group);
  if (!allowed?.providerIds.includes(providerId)) {
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
  const selection: HistoryBackupSelection = { providerId, group };
  if (group === "postgres") {
    const account = await provisionAnonHistoryAccount(providerId);
    selection.claimState = "provisional";
    selection.provisionalAccountId = account.id;
  }
  persistHistoryBinding([...current, selection]);
  if (group === "postgres") {
    const { ensureHistoryClaimNotice } = await import(
      "./history-claim-notice.js"
    );
    await ensureHistoryClaimNotice();
  }
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
export async function persistHistoryToPostgresAccounts(
  ciphertext: Uint8Array,
): Promise<number> {
  const selections = loadHistorySelections().filter(
    (row) => row.group === "postgres" && row.provisionalAccountId,
  );
  let written = 0;
  for (const row of selections) {
    const accountId = row.provisionalAccountId;
    if (!accountId) continue;
    await appendHistoryEntry(accountId, ciphertext);
    written += 1;
  }
  return written;
}

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
  return selections
    .map((row) => historyProviderLabel(row.providerId))
    .join(", ");
}

/** Count of provisional Postgres anon accounts waiting on guest claim. */
export async function countProvisionalHistoryAccounts(): Promise<number> {
  const accounts = await listHistoryAccounts();
  return accounts.filter((row) => row.claimState === "provisional").length;
}
