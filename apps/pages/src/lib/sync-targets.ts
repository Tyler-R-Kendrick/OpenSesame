import { type JsonObject, overlapCast, type BoundaryValue, isString, isTypeofObject } from "@opensesame/os-domain";
/**
 * Host sync target client (WP-C / ADR 0041).
 *
 * Lists and triggers fan-out sync. Responses are metadata only — never secret
 * values or connection tokens.
 */

import { hostFetch } from "./identity.js";

export type SyncTargetStatus = "idle" | "syncing" | "ready" | "error";

export type SyncTarget = {
  id: string;
  projectId: string;
  configId: string;
  connectionId: string;
  providerId: string;
  operation: string;
  status: SyncTargetStatus;
  statusDetail?: string | null;
  contentVersion?: string | null;
  lastSyncedAt?: string | null;
  organizationId: string;
  createdAt: string;
  updatedAt: string;
};

export type SyncTargetOutcome = {
  target: SyncTarget;
  ok: boolean;
  keysSynced: number;
  contentVersion?: string | null;
  error?: string | null;
};

const FORBIDDEN_KEYS =
  /^(value|secret|password|token|access_token|refresh_token)$/i;

function assertNoSecretLeak(value: BoundaryValue, path = "response"): void {
  if (value === null || value === undefined) return;
  if (isString(value)) {
    if (value.length > 64 && /(?:sk_|postgres:\/\/|Bearer\s)/i.test(value)) {
      throw new Error(`${path} may contain secret material`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretLeak(item, path);
    return;
  }
  if (isTypeofObject(value)) {
    for (const [key, nested] of Object.entries(
      overlapCast(value),
    )) {
      if (FORBIDDEN_KEYS.test(key)) {
        throw new Error(`${path} contained forbidden key ${key}`);
      }
      assertNoSecretLeak(nested, `${path}.${key}`);
    }
  }
}

function normalizeTarget(raw: JsonObject): SyncTarget {
  return {
    id: String(raw.id ?? ""),
    projectId: String(raw.project_id ?? raw.projectId ?? ""),
    configId: String(raw.config_id ?? raw.configId ?? ""),
    connectionId: String(raw.connection_id ?? raw.connectionId ?? ""),
    providerId: String(raw.provider_id ?? raw.providerId ?? ""),
    operation: String(raw.operation ?? ""),
    status: overlapCast(String(raw.status ?? "idle")),
    statusDetail:
      isString(raw.status_detail)
        ? raw.status_detail
        : isString(raw.statusDetail)
          ? raw.statusDetail
          : null,
    contentVersion:
      isString(raw.content_version)
        ? raw.content_version
        : isString(raw.contentVersion)
          ? raw.contentVersion
          : null,
    lastSyncedAt:
      isString(raw.last_synced_at)
        ? raw.last_synced_at
        : isString(raw.lastSyncedAt)
          ? raw.lastSyncedAt
          : null,
    organizationId: String(raw.organization_id ?? raw.organizationId ?? ""),
    createdAt: String(raw.created_at ?? raw.createdAt ?? ""),
    updatedAt: String(raw.updated_at ?? raw.updatedAt ?? ""),
  };
}

function normalizeOutcome(raw: JsonObject): SyncTargetOutcome {
  const targetRaw = raw.target;
  if (!targetRaw || !isTypeofObject(targetRaw) || Array.isArray(targetRaw)) {
    throw new Error("sync outcome missing target");
  }
  return {
    target: normalizeTarget(overlapCast(targetRaw)),
    ok: Boolean(raw.ok),
    keysSynced: Number(raw.keys_synced ?? raw.keysSynced ?? 0),
    contentVersion:
      isString(raw.content_version)
        ? raw.content_version
        : isString(raw.contentVersion)
          ? raw.contentVersion
          : null,
    error:
      isString(raw.error)
        ? raw.error
        : raw.error === null
          ? null
          : undefined,
  };
}

async function listSyncTargetsDefault(options?: {
  projectId?: string;
  configId?: string;
}): Promise<SyncTarget[]> {
  const params = new URLSearchParams();
  if (options?.projectId) params.set("project_id", options.projectId);
  if (options?.configId) params.set("config_id", options.configId);
  const qs = params.toString();
  const res = await hostFetch(`/api/v1/sync-targets${qs ? `?${qs}` : ""}`);
  if (!res.ok) {
    throw new Error(`List sync targets failed (${res.status}).`);
  }
  const body = overlapCast(await res.json());
  assertNoSecretLeak(body);
  const targets = (body.sync_targets ?? [])
    .filter(
      (row): row is JsonObject => !!row && isTypeofObject(row),
    )
    .map(normalizeTarget);
  assertNoSecretLeak(targets);
  return targets;
}

export async function createSyncTarget(input: {
  projectId: string;
  configId: string;
  connectionId: string;
  operation?: string;
}): Promise<SyncTarget> {
  const res = await hostFetch("/api/v1/sync-targets", {
    method: "POST",
    body: JSON.stringify({
      project_id: input.projectId,
      config_id: input.configId,
      connection_id: input.connectionId,
      ...(input.operation ? { operation: input.operation } : undefined),
    }),
  });
  if (!res.ok) {
    const err = overlapCast(await res.json().catch(() => null));
    throw new Error(err?.hint ?? `Create sync target failed (${res.status}).`);
  }
  const body = overlapCast(await res.json());
  assertNoSecretLeak(body);
  const target = normalizeTarget(body);
  assertNoSecretLeak(target);
  return target;
}

async function deleteSyncTargetDefault(id: string): Promise<void> {
  const res = await hostFetch(
    `/api/v1/sync-targets/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
    },
  );
  if (!res.ok && res.status !== 204) {
    throw new Error(`Delete sync target failed (${res.status}).`);
  }
}

async function syncTargetDefault(
  id: string,
  options?: { keyNames?: string[] },
): Promise<SyncTargetOutcome> {
  const res = await hostFetch(
    `/api/v1/sync-targets/${encodeURIComponent(id)}/sync`,
    {
      method: "POST",
      body: JSON.stringify({
        ...(options?.keyNames?.length ? { key_names: options.keyNames } : undefined),
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Sync target failed (${res.status}).`);
  }
  const body = overlapCast(await res.json());
  assertNoSecretLeak(body);
  const outcome = normalizeOutcome(body);
  assertNoSecretLeak(outcome);
  return outcome;
}

export async function syncAllForConfig(
  configId: string,
): Promise<SyncTargetOutcome[]> {
  const res = await hostFetch("/api/v1/sync-targets/sync-all", {
    method: "POST",
    body: JSON.stringify({ config_id: configId }),
  });
  if (!res.ok) {
    throw new Error(`Sync-all failed (${res.status}).`);
  }
  const body = overlapCast(await res.json());
  assertNoSecretLeak(body);
  const outcomes = (body.outcomes ?? [])
    .filter(
      (row): row is JsonObject => !!row && isTypeofObject(row),
    )
    .map(normalizeOutcome);
  assertNoSecretLeak(outcomes);
  return outcomes;
}

function formatSyncTargetSummaryDefault(target: SyncTarget): string {
  const parts = [target.providerId, target.operation, target.status];
  if (target.contentVersion) parts.push(`v ${target.contentVersion}`);
  if (target.statusDetail) parts.push(target.statusDetail);
  return parts.join(" · ");
}

export const syncTargetSeams = {
  listSyncTargets: listSyncTargetsDefault,
  deleteSyncTarget: deleteSyncTargetDefault,
  syncTarget: syncTargetDefault,
  formatSyncTargetSummary: formatSyncTargetSummaryDefault,
};

export async function listSyncTargets(options?: {
  projectId?: string;
  configId?: string;
}): Promise<SyncTarget[]> {
  return syncTargetSeams.listSyncTargets(options);
}

export async function deleteSyncTarget(id: string): Promise<void> {
  return syncTargetSeams.deleteSyncTarget(id);
}

export async function syncTarget(
  id: string,
  options?: { keyNames?: string[] },
): Promise<SyncTargetOutcome> {
  return options === undefined
    ? syncTargetSeams.syncTarget(id)
    : syncTargetSeams.syncTarget(id, options);
}

export function formatSyncTargetSummary(target: SyncTarget): string {
  return syncTargetSeams.formatSyncTargetSummary(target);
}
