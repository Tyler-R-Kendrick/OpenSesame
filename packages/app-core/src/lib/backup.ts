/**
 * Browser-local vault backup target (ADR 0128).
 *
 * Bind a private repo via the local GitHub App or a forge git remote;
 * enable/disable and sync run entirely in the SPA. Ciphertext is pushed
 * through the Connect relay.
 */
import type { JsonObject } from "@opensesame/os-domain";
import {
  type PutBackupTargetInput,
  buildLocalBackupTarget,
  resolveProviderId,
  trimInput,
} from "./backup-target-build.js";
import {
  type LocalBackupTarget,
  clearLocalBackupTarget,
  readLocalBackupTarget,
  writeLocalBackupTarget,
} from "./backup-target-local.js";
import { readLocalGithubApp } from "./github-app-local.js";
import {
  publishBackupSyncEvent,
  startVaultBackupObserver,
} from "./vault-backup-observer.js";
import { syncVaultBackup } from "./vault-backup-sync.js";
export type { PutBackupTargetInput } from "./backup-target-build.js";

export type BackupTargetView = {
  kind: string;
  providerId: string | null;
  connectionId: string | null;
  integrationId: string;
  installationId: string;
  owner: string;
  repo: string;
  branch: string;
  enabled: boolean;
  status: string;
  lastCommitSha: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  config: JsonObject | null;
};

export type BackupStatus = {
  target: BackupTargetView | null;
  pendingEvents: number;
};

export type GithubAppPermission = {
  name: string;
  access: string;
};

export type GithubInstallation = {
  id: string;
  accountLogin: string;
  accountType: string;
  targetType: string;
  repositorySelection: string;
  permissions: GithubAppPermission[];
  repositories: string[];
};

function fromLocal(row: LocalBackupTarget): BackupTargetView {
  return {
    kind: row.kind,
    providerId: row.providerId,
    connectionId: row.connectionId,
    integrationId: row.integrationId,
    installationId: row.installationId,
    owner: row.owner,
    repo: row.repo,
    branch: row.branch,
    enabled: row.enabled,
    status: row.status,
    lastCommitSha: row.lastCommitSha,
    lastSyncedAt: row.lastSyncedAt,
    lastError: row.lastError,
    config: row.config,
  };
}

/** Provider catalog id this backup target belongs to. */
export function backupTargetProviderId(
  target: BackupTargetView,
): string | null {
  if (target.providerId) return target.providerId;
  if (target.kind === "connector") return target.providerId;
  if (target.kind === "git_remote") return target.providerId;
  if (
    target.kind === "github_app" ||
    target.integrationId !== "" ||
    target.owner !== ""
  ) {
    return "github";
  }
  return null;
}

async function getBackupStatusDefault(
  providerId?: string | null,
): Promise<BackupStatus> {
  const local = readLocalBackupTarget(providerId);
  if (local?.enabled) startVaultBackupObserver();
  return {
    target: local ? fromLocal(local) : null,
    pendingEvents: local?.pendingEvents ?? 0,
  };
}

async function listGithubInstallationsDefault(
  _integrationId: string,
): Promise<GithubInstallation[]> {
  const app = readLocalGithubApp();
  if (!app) return [];
  return app.installations.map((row) => ({
    id: row.id,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    targetType: row.accountType,
    repositorySelection: "selected",
    permissions: [],
    repositories: [],
  }));
}

async function putBackupTargetDefault(
  input: PutBackupTargetInput,
): Promise<BackupTargetView> {
  const kindHint = trimInput(input.kind);
  const providerId = resolveProviderId(input, kindHint);
  if (providerId === "") {
    throw new Error("Backup needs a provider id.");
  }
  const prior = readLocalBackupTarget(providerId);
  const kind = kindHint || prior?.kind || "github_app";
  const next = buildLocalBackupTarget(input, prior, providerId, kind);
  writeLocalBackupTarget(next);
  if (next.enabled) {
    startVaultBackupObserver();
    publishBackupSyncEvent("configured");
  }
  return fromLocal(readLocalBackupTarget(providerId) ?? next);
}

/** Flip backup on/off without changing the bound repository. */
async function setBackupTargetEnabledDefault(
  enabled: boolean,
  providerId?: string | null,
): Promise<BackupTargetView> {
  const prior = readLocalBackupTarget(providerId);
  if (!prior) {
    throw new Error("No backup target configured");
  }
  const next: LocalBackupTarget = { ...prior, enabled };
  writeLocalBackupTarget(next);
  if (enabled) {
    startVaultBackupObserver();
    publishBackupSyncEvent("enabled");
  }
  return fromLocal(next);
}

async function deleteBackupTargetDefault(
  providerId?: string | null,
): Promise<void> {
  clearLocalBackupTarget(providerId);
}

async function resyncBackupDefault(providerId?: string | null): Promise<void> {
  publishBackupSyncEvent("manual");
  await syncVaultBackup(providerId);
}

export const backupSeams = {
  getBackupStatus: getBackupStatusDefault,
  listGithubInstallations: listGithubInstallationsDefault,
  putBackupTarget: putBackupTargetDefault,
  setBackupTargetEnabled: setBackupTargetEnabledDefault,
  deleteBackupTarget: deleteBackupTargetDefault,
  resyncBackup: resyncBackupDefault,
};

export async function getBackupStatus(
  providerId?: string | null,
): Promise<BackupStatus> {
  return backupSeams.getBackupStatus(providerId);
}

export async function listGithubInstallations(
  integrationId: string,
): Promise<GithubInstallation[]> {
  return backupSeams.listGithubInstallations(integrationId);
}

export async function putBackupTarget(
  input: PutBackupTargetInput,
): Promise<BackupTargetView> {
  return backupSeams.putBackupTarget(input);
}

export async function setBackupTargetEnabled(
  enabled: boolean,
  providerId?: string | null,
): Promise<BackupTargetView> {
  return backupSeams.setBackupTargetEnabled(enabled, providerId);
}

export async function deleteBackupTarget(
  providerId?: string | null,
): Promise<void> {
  return backupSeams.deleteBackupTarget(providerId);
}

export async function resyncBackup(providerId?: string | null): Promise<void> {
  return backupSeams.resyncBackup(providerId);
}

/** Parse `owner/repo` from a GitHub https clone URL or full_name. */
export function ownerRepoFromRemote(remote: string): {
  owner: string;
  repo: string;
} | null {
  const trimmed = remote
    .trim()
    .replace(/\.git$/u, "")
    .replace(/\/$/u, "");
  const https = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/iu);
  if (https?.[1] && https[2]) {
    return { owner: https[1], repo: https[2] };
  }
  const slash = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/u);
  if (slash?.[1] && slash[2]) {
    return { owner: slash[1], repo: slash[2] };
  }
  return null;
}

export function branchForEnvironment(environment: string): string {
  const slug = environment.trim().toLowerCase().replace(/\s+/gu, "-");
  if (!slug || slug === "main" || slug === "master") return "main";
  return `env/${slug}`;
}

export function filterPrivateGithubRepos<T extends { private: boolean }>(
  rows: T[],
): T[] {
  return rows.filter((row) => row.private);
}

export function filterGithubBackupConnections<
  T extends { providerId: string; status: string },
>(rows: T[]): T[] {
  return rows.filter(
    (row) => row.providerId === "github" && row.status === "active",
  );
}

export function installationIdFromLocation(search: string): string | null {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const raw =
    params.get("installation_id") ?? params.get("installationId") ?? "";
  return /^\d+$/.test(raw) ? raw : null;
}

export function githubBackupReturnTo(): string {
  return `${window.location.origin}/settings`;
}

export function githubAppInstallUrl(input: {
  htmlUrl: string | null;
  state?: string;
}): string | null {
  const base = input.htmlUrl?.replace(/\/$/u, "");
  if (!base) return null;
  const url = new URL(`${base}/installations/new`);
  if (input.state) url.searchParams.set("state", input.state);
  return url.toString();
}

export function githubAppFailureReason(raw: string | null): string {
  if (!raw) return "GitHub App setup did not finish.";
  if (raw.includes("state")) return "GitHub App setup state did not match.";
  return raw;
}
