import { Hono } from "hono";
import { AuditEventListResponseSchema } from "@opensesame/contracts";
import type { Variables } from "../middleware/context.js";
import { requirePrincipal } from "../middleware/auth.js";

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
    })),
  });
  return c.json(body);
});
