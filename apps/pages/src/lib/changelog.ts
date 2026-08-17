/**
 * Host + Identity secret/config changelog clients (read-only UI surface).
 *
 * Events are metadata only: project/config ids, key *names*, version ids.
 * Secret values never appear in responses (ADR 0041 / WP-D).
 */

import { hostFetch, identityFetch } from "./identity.js";

/** Frozen event type strings (must match `@opensesame/audit` / WP-B). */
export const SECRET_CHANGELOG_EVENT_TYPES = [
  "project.personal.ensured",
  "secret.config.created",
  "secret.config.updated",
  "secret.config.deleted",
  "secret.value.changed",
  "sync.target.created",
  "sync.target.synced",
  "sync.target.failed",
  "credential.rotation.requested",
  "credential.rotation.succeeded",
  "credential.rotation.failed",
] as const;

export type SecretChangelogEventType =
  (typeof SECRET_CHANGELOG_EVENT_TYPES)[number];

const CHANGELOG_TYPE_SET = new Set<string>(SECRET_CHANGELOG_EVENT_TYPES);

export function isSecretChangelogEventType(
  eventType: string,
): eventType is SecretChangelogEventType {
  return CHANGELOG_TYPE_SET.has(eventType);
}

export type ChangelogEvent = {
  id: string;
  eventType: string;
  occurredAt: string;
  projectId?: string;
  actorId?: string;
  outcome?: string;
  metadata: Record<string, unknown>;
  keyNames?: string[];
  configId?: string;
  environment?: string;
  versionId?: string;
  targetId?: string;
  contentVersion?: string;
};

function assertNoSecretMetadata(events: ChangelogEvent[]): void {
  for (const event of events) {
    for (const key of Object.keys(event.metadata)) {
      if (/^(value|secret|password|token)$/i.test(key)) {
        throw new Error("changelog response contained a forbidden metadata key");
      }
    }
  }
}

function normalizeHostEvent(raw: Record<string, unknown>): ChangelogEvent {
  const metadata =
    raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
      ? (raw.metadata as Record<string, unknown>)
      : {};
  const keyNames = Array.isArray(raw.key_names)
    ? (raw.key_names as unknown[]).filter((n): n is string => typeof n === "string")
    : Array.isArray(metadata.keyNames)
      ? (metadata.keyNames as unknown[]).filter((n): n is string => typeof n === "string")
      : undefined;
  return {
    id: String(raw.id ?? ""),
    eventType: String(raw.event_type ?? raw.eventType ?? ""),
    occurredAt: String(raw.occurred_at ?? raw.occurredAt ?? ""),
    projectId:
      typeof raw.project_id === "string"
        ? raw.project_id
        : typeof raw.projectId === "string"
          ? raw.projectId
          : undefined,
    actorId:
      typeof raw.actor_id === "string"
        ? raw.actor_id
        : typeof raw.actorId === "string"
          ? raw.actorId
          : undefined,
    metadata,
    ...(keyNames ? { keyNames } : {}),
    ...(typeof raw.config_id === "string"
      ? { configId: raw.config_id }
      : typeof metadata.configId === "string"
        ? { configId: metadata.configId }
        : {}),
    ...(typeof raw.environment === "string"
      ? { environment: raw.environment }
      : typeof metadata.environment === "string"
        ? { environment: metadata.environment }
        : {}),
    ...(typeof raw.version_id === "string"
      ? { versionId: raw.version_id }
      : typeof metadata.versionId === "string"
        ? { versionId: metadata.versionId }
        : {}),
    ...(typeof raw.target_id === "string"
      ? { targetId: raw.target_id }
      : typeof metadata.targetId === "string"
        ? { targetId: metadata.targetId }
        : {}),
    ...(typeof raw.content_version === "string"
      ? { contentVersion: raw.content_version }
      : typeof metadata.contentVersion === "string"
        ? { contentVersion: metadata.contentVersion }
        : {}),
  };
}

/** List Host-plane changelog events for a project (authz-gated). */
export async function listHostChangelog(
  projectId: string,
  options?: { limit?: number },
): Promise<ChangelogEvent[]> {
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
  const res = await hostFetch(
    `/api/v1/projects/${encodeURIComponent(projectId)}/changelog?limit=${limit}`,
  );
  if (!res.ok) {
    throw new Error(`Host changelog failed (${res.status}).`);
  }
  const body = (await res.json()) as { events?: unknown[] };
  const events = (body.events ?? [])
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
    .map(normalizeHostEvent);
  assertNoSecretMetadata(events);
  return events;
}

/** List Identity audit events filtered to secret/config changelog types. */
export async function listIdentityChangelog(options?: {
  projectId?: string;
  limit?: number;
}): Promise<ChangelogEvent[]> {
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
  const params = new URLSearchParams({
    changelog: "1",
    limit: String(limit),
  });
  if (options?.projectId) params.set("projectId", options.projectId);
  const res = await identityFetch(`/v1/audit/events?${params}`);
  if (!res.ok) {
    throw new Error(`Identity changelog failed (${res.status}).`);
  }
  const body = (await res.json()) as {
    events?: Array<{
      id: string;
      eventType: string;
      occurredAt: string;
      projectId?: string;
      actorId?: string;
      outcome?: string;
      metadata?: Record<string, unknown>;
    }>;
  };
  let events = (body.events ?? [])
    .filter((e) => isSecretChangelogEventType(e.eventType))
    .filter((e) =>
      options?.projectId ? e.projectId === options.projectId : true,
    )
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      eventType: e.eventType,
      occurredAt: e.occurredAt,
      ...(e.projectId !== undefined ? { projectId: e.projectId } : {}),
      ...(e.actorId !== undefined ? { actorId: e.actorId } : {}),
      ...(e.outcome !== undefined ? { outcome: e.outcome } : {}),
      metadata: e.metadata ?? {},
    }));
  assertNoSecretMetadata(events);
  return events;
}

/** Prefer Host project changelog; fall back to Identity audit filter. */
export async function listChangelog(options: {
  projectId?: string;
  limit?: number;
}): Promise<ChangelogEvent[]> {
  if (options.projectId) {
    try {
      return await listHostChangelog(options.projectId, { limit: options.limit });
    } catch {
      // Host unreachable — Identity filter still useful for config events.
    }
  }
  return listIdentityChangelog(options);
}

export function formatChangelogSummary(event: ChangelogEvent): string {
  const keys =
    event.keyNames?.join(", ") ||
    (Array.isArray(event.metadata.keyNames)
      ? (event.metadata.keyNames as string[]).join(", ")
      : "");
  const config =
    event.configId ||
    (typeof event.metadata.configId === "string" ? event.metadata.configId : "");
  const env =
    event.environment ||
    (typeof event.metadata.environment === "string"
      ? event.metadata.environment
      : "");
  const parts = [event.eventType];
  if (config) parts.push(`config ${config}`);
  if (env) parts.push(env);
  if (keys) parts.push(`keys: ${keys}`);
  if (event.targetId || event.metadata.targetId) {
    parts.push(`target ${event.targetId ?? event.metadata.targetId}`);
  }
  if (event.contentVersion || event.metadata.contentVersion) {
    parts.push(`v ${event.contentVersion ?? event.metadata.contentVersion}`);
  }
  return parts.join(" · ");
}
