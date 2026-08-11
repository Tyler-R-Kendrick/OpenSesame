import { AUDIT_CHAIN_GENESIS, verifyAuditChain } from "@opensesame/audit";
import {
  AuditChainVerifyResponseSchema,
  AuditEventListResponseSchema,
} from "@opensesame/contracts";
import { Hono } from "hono";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";

export const auditRoutes = new Hono<{ Variables: Variables }>();

auditRoutes.get("/events", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = c.get("principalId")!;
  const limitRaw = c.req.query("limit");
  const limit = Math.min(
    Math.max(Number.parseInt(limitRaw ?? "50", 10) || 50, 1),
    200,
  );

  // Callers may only list their own audit trail in this slice.
  const events = await ctx.repos.auditEvents.list({ principalId, limit });
  const body = AuditEventListResponseSchema.parse({
    events: events.map((e) => ({
      id: e.id,
      occurredAt: e.occurredAt.toISOString(),
      eventType: e.eventType,
      outcome: e.outcome,
      correlationId: e.correlationId,
      metadata: e.metadata,
      ...(e.principalId !== undefined ? { principalId: e.principalId } : {}),
      ...(e.actorType !== undefined ? { actorType: e.actorType } : {}),
      ...(e.actorId !== undefined ? { actorId: e.actorId } : {}),
      ...(e.clientId !== undefined ? { clientId: e.clientId } : {}),
      ...(e.organizationId !== undefined
        ? { organizationId: e.organizationId }
        : {}),
      ...(e.projectId !== undefined ? { projectId: e.projectId } : {}),
      ...(e.claimId !== undefined ? { claimId: e.claimId } : {}),
      ...(e.sessionId !== undefined ? { sessionId: e.sessionId } : {}),
      ...(e.targetType !== undefined ? { targetType: e.targetType } : {}),
      ...(e.targetId !== undefined ? { targetId: e.targetId } : {}),
      ...(e.previousDigest !== undefined
        ? { previousDigest: e.previousDigest }
        : {}),
      ...(e.digest !== undefined ? { digest: e.digest } : {}),
    })),
  });
  return c.json(body);
});

/**
 * Re-walk the stored trail and say whether it still hangs together.
 *
 * The chain is over the whole trail, not per principal — a caller's own events
 * are a subsequence of it and cannot be checked against each other. So this walks
 * the contiguous run the store returns, in append order, which is what makes a
 * removed or reordered event detectable at all: `broken` is the shape a deletion
 * takes, `altered` means an event's contents no longer produce its own digest.
 *
 * No event contents are returned, and `eventId` is withheld unless the failing
 * event is the caller's own: whether somebody's trail was tampered with is worth
 * telling any principal, but whose it was is not.
 */
auditRoutes.get("/events/verify", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = c.get("principalId")!;
  const events = await ctx.repos.auditEvents.list({ limit: 200 });
  const oldestFirst = [...events].reverse();
  // The window starts wherever the run does, so the first event is measured
  // against the digest it already claims rather than against genesis.
  const from = oldestFirst[0]?.previousDigest ?? AUDIT_CHAIN_GENESIS;
  const result = verifyAuditChain(oldestFirst, from);
  if (result.ok) {
    return c.json(
      AuditChainVerifyResponseSchema.parse({
        ok: true,
        checked: oldestFirst.length,
      }),
      200,
    );
  }
  const failed = oldestFirst.find((e) => e.id === result.eventId);
  return c.json(
    AuditChainVerifyResponseSchema.parse({
      ok: false,
      checked: oldestFirst.length,
      reason: result.reason,
      ...(failed?.principalId === principalId
        ? { eventId: result.eventId }
        : {}),
    }),
    409,
  );
});
