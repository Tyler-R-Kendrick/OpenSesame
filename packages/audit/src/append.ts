import { randomUUID } from "node:crypto";
import { scrubText } from "@opensesame/log-scrub";
import type {
  AuditActorType,
  AuditEvent,
  AuditOutcome,
  BoundaryValue,
  JsonObject,
} from "@opensesame/os-domain";
import { redactAuditMetadata } from "./redact.js";

export interface AuditSink {
  append(event: AuditEvent, uow?: BoundaryValue): Promise<AuditEvent>;
}

export interface AppendAuditEventInput {
  eventType: string;
  outcome: AuditOutcome;
  correlationId?: string;
  causationId?: string;
  principalId?: string;
  actorType?: AuditActorType;
  actorId?: string;
  agentInstanceId?: string;
  clientId?: string;
  organizationId?: string;
  projectId?: string;
  claimId?: string;
  sessionId?: string;
  targetType?: string;
  targetId?: string;
  metadata?: JsonObject;
  occurredAt?: Date;
  id?: string;
}

/**
 * Build and append a redacted audit event to the given sink
 * (typically `repos.auditEvents`).
 */
export async function appendAuditEvent(
  sink: AuditSink,
  input: AppendAuditEventInput,
): Promise<AuditEvent> {
  const event: AuditEvent = {
    id: input.id ?? randomUUID(),
    occurredAt: input.occurredAt ?? new Date(),
    eventType: input.eventType,
    outcome: input.outcome,
    correlationId: input.correlationId ?? randomUUID(),
    metadata: redactAuditMetadata(input.metadata),
  };
  if (input.causationId !== undefined) event.causationId = input.causationId;
  if (input.principalId !== undefined)
    event.principalId = scrubText(input.principalId);
  if (input.actorType !== undefined) event.actorType = input.actorType;
  if (input.actorId !== undefined) event.actorId = scrubText(input.actorId);
  if (input.agentInstanceId !== undefined) {
    event.agentInstanceId = scrubText(input.agentInstanceId);
  }
  if (input.clientId !== undefined) event.clientId = scrubText(input.clientId);
  if (input.organizationId !== undefined) {
    event.organizationId = input.organizationId;
  }
  if (input.projectId !== undefined) event.projectId = input.projectId;
  if (input.claimId !== undefined) event.claimId = scrubText(input.claimId);
  if (input.sessionId !== undefined)
    event.sessionId = scrubText(input.sessionId);
  if (input.targetType !== undefined)
    event.targetType = scrubText(input.targetType);
  if (input.targetId !== undefined) event.targetId = scrubText(input.targetId);

  return sink.append(event);
}
