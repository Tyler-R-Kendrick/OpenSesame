import { randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { appendAuditEvent } from "@opensesame/audit";
import {
  createProvisionalPrincipal,
} from "@opensesame/auth-upstream";
import {
  IdentityListResponseSchema,
  LinkIdentityRequestSchema,
  LinkIdentityResponseSchema,
  PrincipalMeResponseSchema,
} from "@opensesame/contracts";
import { ConflictError } from "@opensesame/database";
import type {
  ExternalIdentity,
  Principal,
  ProvisionalSession,
} from "@opensesame/os-domain";
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

    // Evict expired provisional sessions/tokens, then enforce capacity.
    const MAX_PROVISIONAL = 1024;
    for (const [id, session] of ctx.stores.provisionalSessions) {
      if (session.expiresAt.getTime() <= now.getTime()) {
        ctx.stores.provisionalSessions.delete(id);
      }
    }
    for (const [token, sessionId] of ctx.stores.provisionalTokens) {
      if (!ctx.stores.provisionalSessions.has(sessionId)) {
        ctx.stores.provisionalTokens.delete(token);
      }
    }
    if (ctx.stores.provisionalSessions.size >= MAX_PROVISIONAL) {
      return c.json(
        { error: "provisional_capacity", message: "Too many provisional sessions" },
        429,
      );
    }

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

    setCookie(c, ctx.config.provisionalCookieName, accessToken, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: Math.floor(ctx.config.provisionalTtlMs / 1000),
      secure: ctx.config.publicUrl.startsWith("https://"),
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

principalRoutes.get("/identities", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = c.get("principalId")!;
  const identities = await ctx.repos.externalIdentities.listByPrincipal(principalId);
  const body = IdentityListResponseSchema.parse({
    identities: identities.map((i) => ({
      id: i.id,
      kind: i.kind,
      issuer: i.issuer,
      subject: i.subject,
      ...(i.displayHint !== undefined ? { displayHint: i.displayHint } : {}),
      assurance: i.assurance,
      linkedAt: i.linkedAt.toISOString(),
    })),
  });
  return c.json(body);
});

principalRoutes.post(
  "/link-identities",
  requirePrincipal(),
  idempotencyMiddleware("principals.link-identities"),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = c.get("principalId")!;
    const principal = await ctx.repos.principals.getById(principalId);
    if (!principal) {
      return c.json({ error: "not_found" }, 404);
    }
    if (principal.state === "suspended" || principal.state === "closed") {
      return c.json({ error: "principal_inactive" }, 403);
    }

    const parsed = LinkIdentityRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }

    const existing = await ctx.repos.externalIdentities.findByTuple({
      kind: parsed.data.kind,
      issuer: parsed.data.issuer,
      ...(parsed.data.tenant !== undefined ? { tenant: parsed.data.tenant } : {}),
      subject: parsed.data.subject,
    });
    if (existing) {
      if (existing.principalId === principalId) {
        return c.json(
          LinkIdentityResponseSchema.parse({
            principalId,
            identity: {
              id: existing.id,
              kind: existing.kind,
              issuer: existing.issuer,
              subject: existing.subject,
              ...(existing.displayHint !== undefined
                ? { displayHint: existing.displayHint }
                : {}),
              assurance: existing.assurance,
              linkedAt: existing.linkedAt.toISOString(),
            },
          }),
        );
      }
      return c.json(
        {
          error: "identity_collision",
          message:
            "External identity already bound to another principal; merge requires dual authentication",
          boundPrincipalId: existing.principalId,
        },
        409,
      );
    }

    // Same email on another principal must never auto-link.
    if (parsed.data.emailNormalized) {
      const emailPeers = await ctx.repos.externalIdentities.listByEmailNormalized(
        parsed.data.emailNormalized,
      );
      const foreign = emailPeers.find((e) => e.principalId !== principalId);
      if (foreign) {
        await appendAuditEvent(ctx.repos.auditEvents, {
          eventType: "principal.identity_link_email_collision",
          outcome: "denied",
          principalId,
          correlationId: c.get("correlationId"),
          metadata: {
            action: "principal.link_identity",
            note: "email_not_used_for_link",
          },
        });
      }
    }

    const now = ctx.clock();
    const identity: ExternalIdentity = {
      id: `xid_${randomUUID()}`,
      principalId,
      kind: parsed.data.kind,
      issuer: parsed.data.issuer,
      subject: parsed.data.subject,
      assurance: parsed.data.assurance,
      linkedAt: now,
      metadata: {},
      ...(parsed.data.tenant !== undefined ? { tenant: parsed.data.tenant } : {}),
      ...(parsed.data.displayHint !== undefined
        ? { displayHint: parsed.data.displayHint }
        : {}),
      ...(parsed.data.emailNormalized !== undefined
        ? { emailNormalized: parsed.data.emailNormalized }
        : {}),
      ...(parsed.data.emailVerified !== undefined
        ? { emailVerified: parsed.data.emailVerified }
        : {}),
    };

    try {
      await ctx.repos.externalIdentities.create(identity);
    } catch (err) {
      if (err instanceof ConflictError) {
        return c.json({ error: "identity_collision", message: err.message }, 409);
      }
      throw err;
    }

    if (principal.assurance === "provisional" || principal.state === "provisional") {
      await ctx.repos.principals.update(
        principalId,
        {
          state: "active",
          assurance:
            parsed.data.assurance === "provisional"
              ? "verified"
              : parsed.data.assurance,
          verifiedAt: now,
          updatedAt: now,
        },
        principal.version,
      );
    }

    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "principal.identity_linked",
      outcome: "succeeded",
      principalId,
      targetType: "external_identity",
      targetId: identity.id,
      correlationId: c.get("correlationId"),
      metadata: {
        action: "principal.link_identity",
        kind: identity.kind,
        issuer: identity.issuer,
      },
    });

    return c.json(
      LinkIdentityResponseSchema.parse({
        principalId,
        identity: {
          id: identity.id,
          kind: identity.kind,
          issuer: identity.issuer,
          subject: identity.subject,
          ...(identity.displayHint !== undefined
            ? { displayHint: identity.displayHint }
            : {}),
          assurance: identity.assurance,
          linkedAt: identity.linkedAt.toISOString(),
        },
      }),
      201,
    );
  },
);

principalRoutes.delete("/identities/:id", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = c.get("principalId")!;
  const identityId = c.req.param("id");
  const identity = await ctx.repos.externalIdentities.getById(identityId);
  if (!identity || identity.principalId !== principalId) {
    return c.json({ error: "not_found" }, 404);
  }
  const deleted = await ctx.repos.externalIdentities.deleteById(identityId);
  if (!deleted) {
    return c.json({ error: "not_found" }, 404);
  }
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "principal.identity_unlinked",
    outcome: "succeeded",
    principalId,
    targetType: "external_identity",
    targetId: identityId,
    correlationId: c.get("correlationId"),
    metadata: { action: "principal.unlink_identity", kind: identity.kind },
  });
  return c.json({ deleted: true, id: identityId });
});
