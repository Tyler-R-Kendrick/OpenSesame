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
  /** Tamper evidence: this event's digest and the one it follows. */
  previousDigest: z.string().optional(),
  digest: z.string().optional(),
});
export type AuditEventResponse = z.infer<typeof AuditEventResponseSchema>;

export const AuditEventListResponseSchema = z.object({
  events: z.array(AuditEventResponseSchema),
});

/** Result of re-walking a stored trail's hash chain. */
export const AuditChainVerifyResponseSchema = z.object({
  ok: z.boolean(),
  checked: z.number().int().nonnegative(),
  reason: z.enum(["unlinked", "altered", "broken"]).optional(),
  eventId: z.string().optional(),
});
export type AuditChainVerifyResponse = z.infer<
  typeof AuditChainVerifyResponseSchema
>;
export type AuditEventListResponse = z.infer<
  typeof AuditEventListResponseSchema
>;
