/**
 * Server-side backup workflow client (ADR 0039).
 *
 * The org installs the GitHub App once and points Host at a repository; from
 * then on every secret change is persisted there by the gateway's backup
 * actor — no CLI, no browser in the loop. These calls carry configuration and
 * status only; token material never crosses the API boundary.
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

function toTarget(raw: Record<string, unknown>): BackupTargetView {
  return {
    integrationId: String(raw.integration_id ?? ""),
    installationId: String(raw.installation_id ?? ""),
    owner: String(raw.owner ?? ""),
    repo: String(raw.repo ?? ""),
    branch: String(raw.branch ?? "main"),
    enabled: Boolean(raw.enabled),
    status: String(raw.status ?? "pending"),
    lastCommitSha: (raw.last_commit_sha as string | null) ?? null,
    lastSyncedAt: (raw.last_synced_at as string | null) ?? null,
    lastError: (raw.last_error as string | null) ?? null,
  };
}

async function fail(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as {
    hint?: string;
    error?: string;
  };
  throw new Error(body.hint || body.error || `${fallback} (${res.status})`);
}

export async function getBackupStatus(): Promise<BackupStatus> {
  const res = await hostFetch("/api/v1/backup/target");
  if (!res.ok) await fail(res, "Could not read backup status");
  const body = (await res.json()) as {
    target?: Record<string, unknown> | null;
    pending_events?: number;
  };
  return {
    target: body.target ? toTarget(body.target) : null,
    pendingEvents: Number(body.pending_events ?? 0),
  };
}

export async function putBackupTarget(input: {
  integrationId: string;
  /** Numeric id from the GitHub App installation (setup redirect query). */
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
      integration_id: input.integrationId,
      installation_id: input.installationId,
      owner: input.owner,
      repo: input.repo,
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    }),
  });
  if (!res.ok) await fail(res, "Could not configure backup");
  const body = (await res.json()) as { target: Record<string, unknown> };
  return toTarget(body.target);
}

export async function deleteBackupTarget(): Promise<void> {
  const res = await hostFetch("/api/v1/backup/target", { method: "DELETE" });
  if (!res.ok) await fail(res, "Could not remove backup target");
}

export async function resyncBackup(): Promise<void> {
  const res = await hostFetch("/api/v1/backup/resync", { method: "POST" });
  if (!res.ok) await fail(res, "Could not queue a resync");
}

/** The `installation_id` GitHub appends to the App setup redirect, if any. */
export function installationIdFromLocation(search: string): string | null {
  const id = new URLSearchParams(search).get("installation_id");
  return id && /^\d+$/.test(id) ? id : null;
}
