import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { appendAuditEvent } from "@opensesame/audit";
import {
  createProvisionalPrincipal,
} from "@opensesame/auth-upstream";
import { PrincipalMeResponseSchema } from "@opensesame/contracts";
import type { Principal, ProvisionalSession } from "@opensesame/os-domain";
import type { Variables } from "../middleware/context.js";
import { requirePrincipal } from "../middleware/auth.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";

export const principalRoutes = new Hono<{ Variables: Variables }>();

principalRoutes.post(
  "/provisional",
  idempotencyMiddleware("principals.provisional"),
  async (c) => {
    const ctx = c.get("ctx");
    const now = ctx.clock();
    const { mapping, session } = await createProvisionalPrincipal(ctx.mappings, {
      ttlMs: ctx.config.provisionalTtlMs,
      quotaProfile: "anonymous",
      allowedActions: [
        "project.create_temporary",
        "resource.create_temporary",
        "claim.create",
        "agent.register_ephemeral",
        "session.continue_anonymous",
      ],
    });

    // Align expires with injected clock for tests
    const provisionalSession: ProvisionalSession = {
      ...session,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ctx.config.provisionalTtlMs),
    };

    const principal: Principal = {
      id: mapping.principalId,
      state: "provisional",
      assurance: "provisional",
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    await ctx.repos.principals.create(principal);
    await ctx.repos.betterAuthSubjects.link({
      betterAuthUserId: mapping.betterAuthUserId,
      principalId: mapping.principalId,
      linkedAt: now,
    });

    const accessToken = `pst_${randomBytes(24).toString("base64url")}`;
    ctx.stores.provisionalSessions.set(provisionalSession.id, provisionalSession);
    ctx.stores.provisionalTokens.set(accessToken, provisionalSession.id);
    ctx.stores.provisionalTokens.set(provisionalSession.id, provisionalSession.id);

    setCookie(c, ctx.config.provisionalCookieName, accessToken, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: Math.floor(ctx.config.provisionalTtlMs / 1000),
    });

    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "principal.provisional_created",
      outcome: "succeeded",
      principalId: principal.id,
      sessionId: provisionalSession.id,
      correlationId: c.get("correlationId"),
      actorType: "human",
      metadata: { action: "principal.provisional_create", quotaProfile: "anonymous" },
    });

    return c.json(
      {
        principalId: principal.id,
        state: principal.state,
        assurance: principal.assurance,
        sessionId: provisionalSession.id,
        accessToken,
        expiresAt: provisionalSession.expiresAt.toISOString(),
        tokenType: "Bearer",
      },
      201,
    );
  },
);

principalRoutes.get("/me", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = c.get("principalId")!;
  const principal = await ctx.repos.principals.getById(principalId);
  if (!principal) {
    return c.json({ error: "not_found" }, 404);
  }
  const identities = await ctx.repos.externalIdentities.listByPrincipal(principalId);
  const body = PrincipalMeResponseSchema.parse({
    id: principal.id,
    state: principal.state,
    assurance: principal.assurance,
    createdAt: principal.createdAt.toISOString(),
    updatedAt: principal.updatedAt.toISOString(),
    ...(principal.verifiedAt
      ? { verifiedAt: principal.verifiedAt.toISOString() }
      : {}),
    version: principal.version,
    identities: identities.map((i) => ({
      id: i.id,
      kind: i.kind,
      issuer: i.issuer,
      ...(i.displayHint !== undefined ? { displayHint: i.displayHint } : {}),
      assurance: i.assurance,
    })),
  });
  return c.json(body);
});
