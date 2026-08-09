import { verifyAuditChain } from "@opensesame/audit";
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
 * Re-walk the caller's own trail and say whether it still hangs together.
 *
 * A caller's events are a subsequence of the whole chain, so this checks each
 * event against its own digest rather than against its neighbour: `altered`
 * means an event's contents no longer produce the digest stored beside it.
 */
auditRoutes.get("/events/verify", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = c.get("principalId")!;
  const events = await ctx.repos.auditEvents.list({ principalId, limit: 200 });
  const oldestFirst = [...events].reverse();
  let verdict = AuditChainVerifyResponseSchema.parse({
    ok: true,
    checked: oldestFirst.length,
  });
  for (const event of oldestFirst) {
    const single = verifyAuditChain([event], event.previousDigest ?? "");
    if (!single.ok) {
      verdict = AuditChainVerifyResponseSchema.parse({
        ok: false,
        checked: oldestFirst.length,
        reason: single.reason,
        eventId: single.eventId,
      });
      break;
    }
  }
  return c.json(verdict, verdict.ok ? 200 : 409);
});
