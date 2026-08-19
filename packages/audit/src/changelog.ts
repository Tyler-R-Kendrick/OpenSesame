import type { AuditActorType, AuditOutcome } from "@opensesame/os-domain";
import {
  type AppendAuditEventInput,
  type AuditSink,
  appendAuditEvent,
} from "./append.js";
import { redactAuditMetadata } from "./redact.js";

/**
 * Frozen secret/config changelog event type strings (WP-B / one-shot prompt).
 * Keep in sync with Host `changelog_hook` and Pages clients.
 */
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

/** Metadata allowed on secret/config changelog events (never values). */
export type SecretChangelogMetadata = {
  configId?: string;
  environment?: string;
  /** Secret / config key *names* only — never values or reversible digests. */
  keyNames?: string[];
  versionId?: string;
  targetId?: string;
  contentVersion?: string;
  actor?: string;
  reason?: string;
  outcome?: string;
};

export type RecordSecretChangelogInput = {
  eventType: SecretChangelogEventType;
  outcome?: AuditOutcome;
  projectId: string;
  principalId?: string;
  actorType?: AuditActorType;
  actorId?: string;
  organizationId?: string;
  correlationId?: string;
  causationId?: string;
  targetType?: string;
  targetId?: string;
  metadata?: SecretChangelogMetadata & Record<string, unknown>;
  occurredAt?: Date;
  id?: string;
};

/**
 * Append a redacted secret/config changelog audit event.
 *
 * Callers must pass key *names* and version ids only. Any `value` / `secret` /
 * `password` / `token` metadata keys are stripped by {@link redactAuditMetadata}.
 */
export async function recordSecretChangelog(
  sink: AuditSink,
  input: RecordSecretChangelogInput,
): Promise<Awaited<ReturnType<typeof appendAuditEvent>>> {
  if (!isSecretChangelogEventType(input.eventType)) {
    throw new Error(`not a secret changelog event type: ${input.eventType}`);
  }

  const metadata = redactAuditMetadata({
    ...input.metadata,
    ...(input.metadata?.configId !== undefined
      ? { configId: input.metadata.configId }
      : {}),
    ...(input.metadata?.environment !== undefined
      ? { environment: input.metadata.environment }
      : {}),
    ...(input.metadata?.keyNames !== undefined
      ? { keyNames: input.metadata.keyNames }
      : {}),
    ...(input.metadata?.versionId !== undefined
      ? { versionId: input.metadata.versionId }
      : {}),
    ...(input.metadata?.targetId !== undefined
      ? { targetId: input.metadata.targetId }
      : {}),
    ...(input.metadata?.contentVersion !== undefined
      ? { contentVersion: input.metadata.contentVersion }
      : {}),
    ...(input.metadata?.actor !== undefined
      ? { actor: input.metadata.actor }
      : {}),
  });

  const appendInput: AppendAuditEventInput = {
    eventType: input.eventType,
    outcome: input.outcome ?? "succeeded",
    projectId: input.projectId,
    metadata,
  };
  if (input.id !== undefined) appendInput.id = input.id;
  if (input.occurredAt !== undefined) appendInput.occurredAt = input.occurredAt;
  if (input.principalId !== undefined) {
    appendInput.principalId = input.principalId;
  }
  if (input.actorType !== undefined) appendInput.actorType = input.actorType;
  if (input.actorId !== undefined) appendInput.actorId = input.actorId;
  if (input.organizationId !== undefined) {
    appendInput.organizationId = input.organizationId;
  }
  if (input.correlationId !== undefined) {
    appendInput.correlationId = input.correlationId;
  }
  if (input.causationId !== undefined) {
    appendInput.causationId = input.causationId;
  }
  if (input.targetType !== undefined) appendInput.targetType = input.targetType;
  if (input.targetId !== undefined) appendInput.targetId = input.targetId;

  return appendAuditEvent(sink, appendInput);
}

/** Filter a trail to changelog event types (and optional project). */
export function filterSecretChangelogEvents<
  T extends { eventType: string; projectId?: string },
>(events: readonly T[], options?: { projectId?: string; limit?: number }): T[] {
  let out = events.filter((e) => isSecretChangelogEventType(e.eventType));
  if (options?.projectId) {
    out = out.filter((e) => e.projectId === options.projectId);
  }
  if (options?.limit !== undefined) {
    out = out.slice(0, options.limit);
  }
  return out;
}
