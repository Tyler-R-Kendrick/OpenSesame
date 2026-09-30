/**
 * Forge backup connectors saved on this device. The sync reads the token
 * from here when a Capabilities configuration is present.
 */

import {
  type GitBackupForge,
  forgeForProvider,
  forgeFromRemoteUrl,
} from "./git-backup-forges.js";

export type SavedGitBackup = {
  providerId: string;
  operation: string;
  fields: Record<string, string>;
  secret: Record<string, string>;
};

export type SavedForgeCredentials = {
  forge: GitBackupForge;
  token: string;
  username: null;
};

let savedGit: SavedGitBackup[] = [];

/** Hold the backup requests the sync will send. */
export function bindSavedGitBackup(uses: readonly SavedGitBackup[]): void {
  savedGit = uses.map((row) => ({
    providerId: row.providerId,
    operation: row.operation,
    fields: { ...row.fields },
    secret: { ...row.secret },
  }));
}

export function savedGitBackupUse(providerId: string): SavedGitBackup | null {
  const row = savedGit.find((item) => item.providerId === providerId);
  if (!row) return null;
  return {
    providerId: row.providerId,
    operation: row.operation,
    fields: { ...row.fields },
    secret: { ...row.secret },
  };
}

export function resetSavedGitBackupForTest(): void {
  savedGit = [];
}

/** Token from a saved forge connector, when the remote URL names a forge. */
export function savedForgeCredentials(
  providerId: string,
): SavedForgeCredentials | null {
  const saved = savedGitBackupUse(providerId);
  const remoteUrl = saved?.fields.remote_url ?? "";
  const token = saved?.secret.token;
  if (!token || remoteUrl === "") return null;
  const forge =
    forgeForProvider(saved.providerId) ?? forgeFromRemoteUrl(remoteUrl);
  if (!forge) return null;
  return { forge, token, username: null };
}
