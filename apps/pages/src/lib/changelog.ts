import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
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
  "secret.value.rolled_back",
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
  /** Durable-store cursor (Host plane); absent on cache-only rows. */
  seq?: number;
  eventType: string;
  occurredAt: string;
  projectId?: string;
  actorId?: string;
  outcome?: string;
  metadata: JsonObject;
  keyNames?: string[];
  configId?: string;
  environment?: string;
  versionId?: string;
  targetId?: string;
  contentVersion?: string;
};

export type ChangelogOptions = {
  projectId?: string;
  limit?: number;
};

function assertNoSecretMetadata(events: ChangelogEvent[]): void {
  for (const event of events) {
    for (const key of Object.keys(event.metadata)) {
      if (/^(value|secret|password|token)$/i.test(key)) {
        throw new Error(
          "changelog response contained a forbidden metadata key",
        );
      }
    }
  }
}

function normalizeHostEvent(raw: JsonObject): ChangelogEvent {
  const metadata: JsonObject = isJsonObject(raw.metadata)
    ? overlapCast(raw.metadata)
    : {};
  const keyNames = Array.isArray(raw.key_names)
    ? raw.key_names.filter((n): n is string => isString(n))
    : Array.isArray(metadata.keyNames)
      ? metadata.keyNames.filter((n): n is string => isString(n))
      : undefined;
  return {
    id: String(raw.id ?? ""),
    ...(isNumber(raw.seq) ? { seq: raw.seq } : undefined),
    eventType: String(raw.event_type ?? raw.eventType ?? ""),
    occurredAt: String(raw.occurred_at ?? raw.occurredAt ?? ""),
    projectId: isString(raw.project_id)
      ? raw.project_id
      : isString(raw.projectId)
        ? raw.projectId
        : undefined,
    actorId: isString(raw.actor_id)
      ? raw.actor_id
      : isString(raw.actorId)
        ? raw.actorId
        : undefined,
    metadata,
    ...(keyNames ? { keyNames } : undefined),
    ...(isString(raw.config_id)
      ? { configId: raw.config_id }
      : isString(metadata.configId)
        ? { configId: metadata.configId }
        : {}),
    ...(isString(raw.environment)
      ? { environment: raw.environment }
      : isString(metadata.environment)
        ? { environment: metadata.environment }
        : {}),
    ...(isString(raw.version_id)
      ? { versionId: raw.version_id }
      : isString(metadata.versionId)
        ? { versionId: metadata.versionId }
        : {}),
    ...(isString(raw.target_id)
      ? { targetId: raw.target_id }
      : isString(metadata.targetId)
        ? { targetId: metadata.targetId }
        : {}),
    ...(isString(raw.content_version)
      ? { contentVersion: raw.content_version }
      : isString(metadata.contentVersion)
        ? { contentVersion: metadata.contentVersion }
        : {}),
  };
}

/** One durable-store page: events plus the cursor for the next-older page. */
export type ChangelogPage = {
  events: ChangelogEvent[];
  /** Pass as `beforeSeq` to fetch the next-older page; null when exhausted. */
  nextBeforeSeq: number | null;
};

/** List one cursor-paged Host changelog page for a project (authz-gated). */
async function listHostChangelogPageDefault(
  projectId: string,
  options?: { limit?: number; beforeSeq?: number },
): Promise<ChangelogPage> {
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
  const params = new URLSearchParams({ limit: String(limit) });
  if (options?.beforeSeq !== undefined) {
    params.set("before_seq", String(options.beforeSeq));
  }
  const res = await hostFetch(
    `/api/v1/projects/${encodeURIComponent(projectId)}/changelog?${params}`,
  );
  if (!res.ok) {
    throw new Error(`Host changelog failed (${res.status}).`);
  }
  const body: { events?: BoundaryValue[]; next_before_seq?: BoundaryValue } =
    overlapCast(await res.json());
  const events = (body.events ?? [])
    .filter((row): row is JsonObject => isJsonObject(row))
    .map(normalizeHostEvent);
  assertNoSecretMetadata(events);
  return {
    events,
    nextBeforeSeq: isNumber(body.next_before_seq) ? body.next_before_seq : null,
  };
}

export async function listHostChangelogPage(
  projectId: string,
  options?: { limit?: number; beforeSeq?: number },
): Promise<ChangelogPage> {
  return options === undefined
    ? changelogSeams.listHostChangelogPage(projectId)
    : changelogSeams.listHostChangelogPage(projectId, options);
}

/** List Host-plane changelog events for a project (authz-gated). */
export async function listHostChangelog(
  projectId: string,
  options?: ChangelogOptions,
): Promise<ChangelogEvent[]> {
  const page = await listHostChangelogPageDefault(
    projectId,
    options === undefined ? undefined : { ...options },
  );
  return page.events;
}

/** List Identity audit events filtered to secret/config changelog types. */
export async function listIdentityChangelog(
  options?: ChangelogOptions,
): Promise<ChangelogEvent[]> {
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
  const body: { events?: ChangelogEvent[] } = overlapCast(await res.json());
  const events = (body.events ?? [])
    .filter((e) => isSecretChangelogEventType(e.eventType))
    .filter((e) =>
      options?.projectId ? e.projectId === options.projectId : true,
    )
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      eventType: e.eventType,
      occurredAt: e.occurredAt,
      ...(e.projectId !== undefined ? { projectId: e.projectId } : undefined),
      ...(e.actorId !== undefined ? { actorId: e.actorId } : undefined),
      ...(e.outcome !== undefined ? { outcome: e.outcome } : undefined),
      metadata: e.metadata ?? {},
    }));
  assertNoSecretMetadata(events);
  return events;
}

/** Prefer Host project changelog; fall back to Identity audit filter. */
async function listChangelogDefault(
  options: ChangelogOptions,
): Promise<ChangelogEvent[]> {
  if (options.projectId) {
    try {
      return await listHostChangelog(options.projectId, {
        limit: options.limit,
      });
    } catch {
      // Host unreachable — Identity filter still useful for config events.
    }
  }
  return listIdentityChangelog(options);
}

function formatChangelogSummaryDefault(event: ChangelogEvent): string {
  const metadataKeyNames = event.metadata.keyNames;
  const keys =
    event.keyNames?.join(", ") ||
    (Array.isArray(metadataKeyNames)
      ? metadataKeyNames.filter(isString).join(", ")
      : "");
  const config =
    event.configId ||
    (isString(event.metadata.configId) ? event.metadata.configId : "");
  const env =
    event.environment ||
    (isString(event.metadata.environment) ? event.metadata.environment : "");
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

export const changelogSeams = {
  listChangelog: listChangelogDefault,
  listHostChangelogPage: listHostChangelogPageDefault,
  formatChangelogSummary: formatChangelogSummaryDefault,
};

export async function listChangelog(
  options: ChangelogOptions,
): Promise<ChangelogEvent[]> {
  return changelogSeams.listChangelog(options);
}

export function formatChangelogSummary(event: ChangelogEvent): string {
  return changelogSeams.formatChangelogSummary(event);
}
