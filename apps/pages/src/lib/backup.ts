import {
  type JsonObject,
  overlapCast,
  isTypeofObject,
  readJsonObject,
  readString,
} from "@opensesame/os-domain";
/**
 * Server-side backup workflow client (ADR 0039).
 *
 * Configure via an active GitHub History connection + private repo + App
 * installation — never by picking unrelated catalog integrations.
 */

import { hostFetch } from "./identity.js";

export type BackupTargetView = {
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
};

export type BackupStatus = {
  target: BackupTargetView | null;
  pendingEvents: number;
};

export type GithubInstallation = {
  id: string;
  accountLogin: string;
  accountType: string;
  targetType: string;
};

function toTarget(raw: JsonObject): BackupTargetView {
  return {
    integrationId: String(raw.integration_id ?? ""),
    installationId: String(raw.installation_id ?? ""),
    owner: String(raw.owner ?? ""),
    repo: String(raw.repo ?? ""),
    branch: String(raw.branch ?? "main"),
    enabled: Boolean(raw.enabled),
    status: String(raw.status ?? "pending"),
    lastCommitSha: (overlapCast(raw.last_commit_sha)) ?? null,
    lastSyncedAt: (overlapCast(raw.last_synced_at)) ?? null,
    lastError: (overlapCast(raw.last_error)) ?? null,
  };
}

async function fail(res: Response, fallback: string): Promise<never> {
  const body = overlapCast(await res.json().catch(() => ({})));
  throw new Error(
    readString(body.hint) ||
      readString(body.error) ||
      `${fallback} (${res.status})`,
  );
}

async function getBackupStatusDefault(): Promise<BackupStatus> {
  const res = await hostFetch("/api/v1/backup/target");
  if (!res.ok) await fail(res, "Could not read backup status");
  const body = overlapCast(await res.json());
  const target = readJsonObject(body.target);
  return {
    target: target ? toTarget(target) : null,
    pendingEvents: Number(body.pending_events ?? 0),
  };
}

async function listGithubInstallationsDefault(
  integrationId: string,
): Promise<GithubInstallation[]> {
  const res = await hostFetch(
    `/api/v1/integrations/${encodeURIComponent(integrationId)}/github/installations`,
  );
  if (!res.ok) await fail(res, "Could not list GitHub App installations");
  const body = overlapCast(await res.json());
  const installations = body.installations;
  const rows = Array.isArray(installations) ? installations : [];
  return rows
    .filter(
      (row): row is JsonObject => !!row && isTypeofObject(row),
    )
    .map((row) => ({
      id: String(row.id ?? ""),
      accountLogin: String(row.account_login ?? ""),
      accountType: String(row.account_type ?? ""),
      targetType: String(row.target_type ?? ""),
    }))
    .filter((row) => /^\d+$/.test(row.id));
}

async function putBackupTargetDefault(input: {
  connectionId?: string;
  integrationId?: string;
  installationId: string;
  owner: string;
  repo: string;
  branch?: string;
  enabled?: boolean;
}): Promise<BackupTargetView> {
  const res = await hostFetch("/api/v1/backup/target", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(input.connectionId ? { connection_id: input.connectionId } : undefined),
      ...(input.integrationId ? { integration_id: input.integrationId } : undefined),
      installation_id: input.installationId,
      owner: input.owner,
      repo: input.repo,
      ...(input.branch ? { branch: input.branch } : undefined),
      ...(input.enabled === undefined ? undefined : { enabled: input.enabled }),
    }),
  });
  if (!res.ok) await fail(res, "Could not configure backup");
  const body = overlapCast(await res.json());
  const target = readJsonObject(body.target);
  if (!target) {
    throw new Error("Host returned no backup target");
  }
  return toTarget(target);
}

async function deleteBackupTargetDefault(): Promise<void> {
  const res = await hostFetch("/api/v1/backup/target", { method: "DELETE" });
  if (!res.ok) await fail(res, "Could not remove backup target");
}

async function resyncBackupDefault(): Promise<void> {
  const res = await hostFetch("/api/v1/backup/resync", { method: "POST" });
  if (!res.ok) await fail(res, "Could not queue a resync");
}

export const backupSeams = {
  getBackupStatus: getBackupStatusDefault,
  listGithubInstallations: listGithubInstallationsDefault,
  putBackupTarget: putBackupTargetDefault,
  deleteBackupTarget: deleteBackupTargetDefault,
  resyncBackup: resyncBackupDefault,
};

export async function getBackupStatus(): Promise<BackupStatus> {
  return backupSeams.getBackupStatus();
}

export async function listGithubInstallations(
  integrationId: string,
): Promise<GithubInstallation[]> {
  return backupSeams.listGithubInstallations(integrationId);
}

export async function putBackupTarget(
  input: Parameters<typeof putBackupTargetDefault>[0],
): Promise<BackupTargetView> {
  return backupSeams.putBackupTarget(input);
}

export async function deleteBackupTarget(): Promise<void> {
  return backupSeams.deleteBackupTarget();
}

export async function resyncBackup(): Promise<void> {
  return backupSeams.resyncBackup();
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

/** Map SecretConfig environment → default backup branch name. */
export function branchForEnvironment(
  environment: "development" | "staging" | "production" | "custom" | string,
): string {
  switch (environment) {
    case "development":
      return "env/development";
    case "staging":
      return "env/staging";
    case "production":
      return "env/production";
    default:
      return `env/${environment.replace(/[^a-zA-Z0-9._/-]+/gu, "-")}`;
  }
}

/**
 * Recoverability only lists History GitHub connections — never Stripe/OpenAI
 * catalog rows that used to poison the old integration dropdown.
 */
export function filterGithubBackupConnections<
  T extends { providerId: string; status: string },
>(rows: T[]): T[] {
  return rows.filter(
    (row) =>
      row.providerId === "github" &&
      (row.status === "active" || row.status === "needs_reauth"),
  );
}

/** Password recoverability repos must be private. */
export function filterPrivateGithubRepos<
  T extends { private: boolean; cloneUrl: string },
>(rows: T[]): T[] {
  return rows.filter(
    (row) => row.private && row.cloneUrl.startsWith("https://"),
  );
}

/**
 * Prefer the App's public html_url; otherwise derive a best-effort install URL
 * from the App display name (GitHub slugifies names the same way).
 */
export function githubAppInstallUrl(input: {
  htmlUrl?: string | null;
  displayName?: string | null;
}): string | null {
  const html = (input.htmlUrl ?? "").trim().replace(/\/$/u, "");
  if (html.startsWith("https://github.com/apps/")) {
    return `${html}/installations/new`;
  }
  const name = (input.displayName ?? "").trim().toLowerCase();
  if (!name) return null;
  const slug = name
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  if (!slug) return null;
  return `https://github.com/apps/${slug}/installations/new`;
}

export function githubAppFailureReason(raw: string | null): string {
  switch ((raw ?? "").trim()) {
    case "":
      return "unknown error";
    case "missing_state":
    case "missing_code":
      return "GitHub returned an incomplete redirect. Keep the Host running and try Create GitHub App again.";
    case "unknown_or_expired_state":
    case "expired_state":
      return "That registration session expired or the Host restarted. Create the GitHub App again (Host must stay up during the handshake).";
    case "conversion_failed":
      return "GitHub created the app but Host could not exchange the one-time code. Retry Create GitHub App while Host stays reachable.";
    default:
      return (raw ?? "").trim();
  }
}

/** Settings URL that GitHub App registration/install should return to. */
export function githubBackupReturnTo(): string {
  const base = import.meta.env.BASE_URL.replace(/\/?$/u, "/");
  return `${window.location.origin}${base}settings`;
}

/** The `installation_id` GitHub appends to the App setup redirect, if any. */
export function installationIdFromLocation(search: string): string | null {
  const id = new URLSearchParams(search).get("installation_id");
  return id && /^\d+$/.test(id) ? id : null;
}
