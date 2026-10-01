/**
 * Forge backup connectors saved on this device. The sync reads the token
 * from here when a Capabilities configuration is present.
 */

import { runListedFeature } from "./feature-connector-operation.js";
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
  fields: Record<string, string>;
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

/** Token from the forge connector saved on this device, read when a sync runs. */
export function savedForgeCredentials(
  providerId: string,
): SavedForgeCredentials | null {
  const live = runListedFeature(providerId);
  if (!live.ok) return null;
  const remoteUrl = live.action.remote_url ?? "";
  const token = live.secrets.token || live.secrets.credential || "";
  if (token === "" || remoteUrl === "") return null;
  const forge =
    forgeForProvider(live.providerId) ?? forgeFromRemoteUrl(remoteUrl);
  if (!forge) return null;
  return {
    forge,
    token,
    username: null,
    fields: { ...live.action },
  };
}
