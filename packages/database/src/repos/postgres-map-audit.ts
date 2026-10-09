/**
 * Map a Postgres audit_events row to the domain AuditEvent.
 */

import type { AuditEvent } from "@opensesame/os-domain";
import type * as schema from "../schema/index.js";

function overlapCast<T>(value: unknown): T {
  // SAFETY: column checks / jsonb shape constrained at write time.
  return value as T;
}

function setIfPresent<K extends keyof AuditEvent>(
  target: AuditEvent,
  key: K,
  value: AuditEvent[K] | null | undefined,
): void {
  if (value) target[key] = value;
}

export function mapAuditEvent(
  row: typeof schema.auditEvents.$inferSelect,
): AuditEvent {
  const mapped: AuditEvent = {
    id: row.id,
    occurredAt: row.occurredAt,
    eventType: row.eventType,
    outcome: overlapCast(row.outcome),
    correlationId: row.correlationId,
    metadata: overlapCast(row.metadata ?? {}),
  };
  setIfPresent(mapped, "principalId", row.principalId);
  if (row.actorType) mapped.actorType = overlapCast(row.actorType);
  setIfPresent(mapped, "actorId", row.actorId);
  setIfPresent(mapped, "agentInstanceId", row.agentInstanceId);
  setIfPresent(mapped, "clientId", row.clientId);
  setIfPresent(mapped, "organizationId", row.organizationId);
  setIfPresent(mapped, "projectId", row.projectId);
  setIfPresent(mapped, "claimId", row.claimId);
  setIfPresent(mapped, "sessionId", row.sessionId);
  setIfPresent(mapped, "targetType", row.targetType);
  setIfPresent(mapped, "targetId", row.targetId);
  setIfPresent(mapped, "causationId", row.causationId);
  setIfPresent(mapped, "previousDigest", row.previousDigest);
  setIfPresent(mapped, "digest", row.digest);
  return mapped;
}
