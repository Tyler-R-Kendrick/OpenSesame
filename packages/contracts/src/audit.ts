import { z } from "zod";

export const AuditEventResponseSchema = z.object({
  id: z.string(),
  occurredAt: z.string().datetime(),
  eventType: z.string(),
  principalId: z.string().optional(),
  actorType: z.enum(["human", "agent", "workload", "system"]).optional(),
  actorId: z.string().optional(),
  clientId: z.string().optional(),
  organizationId: z.string().optional(),
  projectId: z.string().optional(),
  claimId: z.string().optional(),
  sessionId: z.string().optional(),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  outcome: z.enum(["succeeded", "failed", "denied"]),
  correlationId: z.string(),
  metadata: z.record(z.string(), z.unknown()),
});
export type AuditEventResponse = z.infer<typeof AuditEventResponseSchema>;

export const AuditEventListResponseSchema = z.object({
  events: z.array(AuditEventResponseSchema),
});
export type AuditEventListResponse = z.infer<
  typeof AuditEventListResponseSchema
>;
