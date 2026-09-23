import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
/**
 * Identity secret/config changelog client (read-only UI surface).
 *
 * Events are metadata only: project/config ids, key *names*, version ids.
 * Secret values never appear in responses (ADR 0041 / WP-D).
 */

import { identityFetch } from "./identity.js";

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
  return events;
}

/** List Identity audit events filtered to secret/config changelog types. */

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
  listChangelog: listIdentityChangelog,
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
