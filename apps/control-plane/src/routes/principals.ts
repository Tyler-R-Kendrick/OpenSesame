import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import { createProvisionalPrincipal } from "@opensesame/auth-upstream";
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
import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { decodeJwt } from "jose";
import { cookieAuthAllowed, requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { serializeKeyed } from "../serialize.js";
import { OrgAssertionError, verifyOrgIdToken } from "./org-assertion.js";
import {
  authenticatedPrincipalId,
  ensurePersonalOrganization,
} from "./organizations.js";

export const principalRoutes = new Hono<{ Variables: Variables }>();

export const MAX_PROVISIONAL = 1024;
const PROVISIONAL_MINT_WINDOW_MS = 60_000;
const PROVISIONAL_MINT_PER_CLIENT = 10;
const PROVISIONAL_MINT_GLOBAL = 120;
const PROVISIONAL_MINT_KEYS = 2048;

export function consumeProvisionalMintBudget(
  map: Map<string, number[]>,
  fingerprint: string,
  now: number,
): boolean {
  for (const [key, values] of map) {
    const live = values.filter((at) => now - at < PROVISIONAL_MINT_WINDOW_MS);
    if (live.length === 0) map.delete(key);
    else if (live.length !== values.length) map.set(key, live);
  }
  const global = map.get("__global__") ?? [];
  const client = map.get(fingerprint) ?? [];
  if (
    global.length >= PROVISIONAL_MINT_GLOBAL ||
    client.length >= PROVISIONAL_MINT_PER_CLIENT
  ) {
    return false;
  }
  global.push(now);
  client.push(now);
  map.set("__global__", global);
  map.set(fingerprint, client);
  while (map.size > PROVISIONAL_MINT_KEYS) {
    const victim = [...map.keys()].find((key) => key !== "__global__");
    if (victim === undefined) break;
    map.delete(victim);
  }
  return true;
}

principalRoutes.post(
  "/provisional",
  idempotencyMiddleware("principals.provisional"),
  async (c) => {
    const ctx = c.get("ctx");
    const now = ctx.clock();

    return serializeKeyed(
      ctx.stores.principalMutations,
      "provisional-mint",
      async () => {
        // Expiry removes both the live lease and its unclaimed durable identity.
        for (const [id, session] of ctx.stores.provisionalSessions) {
          if (session.expiresAt.getTime() > now.getTime()) continue;
          ctx.stores.provisionalSessions.delete(id);
          const deleted = await ctx.repos.principals.deleteUnlinkedProvisional(
            session.principalId,
          );
          if (deleted)
            await ctx.mappings.deleteProvisional(session.principalId);
        }
        for (const [token, sessionId] of ctx.stores.provisionalTokens) {
          if (!ctx.stores.provisionalSessions.has(sessionId)) {
            ctx.stores.provisionalTokens.delete(token);
          }
        }
        if (ctx.stores.provisionalSessions.size >= MAX_PROVISIONAL) {
          return c.json(
            {
              error: "provisional_capacity",
              message: "Too many provisional sessions",
            },
            429,
          );
        }

        const fingerprint = createHash("sha256")
          .update(c.req.header("user-agent") ?? "")
          .update("|")
          .update(c.req.header("origin") ?? "")
          .digest("hex")
          .slice(0, 16);
        if (
          !consumeProvisionalMintBudget(
            ctx.stores.provisionalMints,
            fingerprint,
            now.getTime(),
          )
        ) {
          return c.json({ error: "rate_limited" }, 429);
        }

        const { mapping, session } = await createProvisionalPrincipal(
          ctx.mappings,
          {
            ttlMs: ctx.config.provisionalTtlMs,
            quotaProfile: "anonymous",
            allowedActions: [
              "project.create",
              "project.create_temporary",
              "resource.create_temporary",
              "claim.create",
              "agent.register_ephemeral",
              "session.continue_anonymous",
            ],
          },
        );

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
        try {
          await ctx.repos.principals.create(principal);
          await ctx.repos.betterAuthSubjects.link({
            betterAuthUserId: mapping.betterAuthUserId,
            principalId: mapping.principalId,
            linkedAt: now,
          });
        } catch (error) {
          await ctx.repos.principals.deleteUnlinkedProvisional(principal.id);
          await ctx.mappings.deleteProvisional(principal.id);
          throw error;
        }

        if (ctx.config.bootstrapPersonalOrganization) {
          ensurePersonalOrganization(ctx, principal.id);
        }

        const accessToken = `pst_${randomBytes(24).toString("base64url")}`;
        ctx.stores.provisionalSessions.set(
          provisionalSession.id,
          provisionalSession,
        );
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
          metadata: {
            action: "principal.provisional_create",
            quotaProfile: "anonymous",
          },
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
  },
);

/**
 * End the caller's provisional session. Clearing client memory is not enough:
 * the cookie alone authenticates, so the session must die server-side too.
 */
principalRoutes.post("/provisional/revoke", async (c) => {
  const ctx = c.get("ctx");
  const principalId = c.get("principalId");
  const cookie = getCookie(c, ctx.config.provisionalCookieName);

  // A bearer takes precedence over a cookie for authentication, so a request
  // carrying both would otherwise revoke the bearer's session while clearing a
  // cookie belonging to another — leaving that one alive and unreachable. Both
  // were presented, so end both.
  const revoking = new Set<string>();
  const authenticated = c.get("provisionalSessionId");
  if (authenticated) revoking.add(authenticated);
  if (cookie) {
    if (!cookieAuthAllowed(ctx, c.req.method, c.req.header("origin"))) {
      return c.json({ error: "forbidden", hint: "origin required" }, 403);
    }
    const fromCookie = ctx.stores.provisionalTokens.get(cookie);
    if (fromCookie) revoking.add(fromCookie);
  }

  for (const sessionId of revoking) {
    const session = ctx.stores.provisionalSessions.get(sessionId);
    if (session) {
      ctx.stores.provisionalSessions.set(sessionId, {
        ...session,
        revokedAt: ctx.clock(),
      });
    }
    for (const [token, id] of ctx.stores.provisionalTokens) {
      if (id === sessionId) ctx.stores.provisionalTokens.delete(token);
    }
    // Attribute to whoever owned the session that ended, not to whichever
    // credential authenticated the request: with two sessions in play those are
    // different principals, and each trail should show its own session going.
    const owner = session?.principalId ?? principalId;
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "principal.provisional_revoked",
      outcome: "succeeded",
      ...(owner !== undefined ? { principalId: owner } : undefined),
      sessionId,
      correlationId: c.get("correlationId"),
      actorType: "human",
      metadata: { action: "principal.provisional_revoke" },
    });
  }

  // Clear only a cookie this request actually presented. Deleting
  // unconditionally would let a late response wipe a cookie issued by a newer
  // session, since deletion is by name and cannot name a value. Attributes must
  // match the ones it was set with or the browser keeps the original.
  if (cookie !== undefined) {
    deleteCookie(c, ctx.config.provisionalCookieName, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      secure: ctx.config.publicUrl.startsWith("https://"),
    });
  }
  return c.body(null, 204);
});

principalRoutes.get("/me", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const principal = await ctx.repos.principals.getById(principalId);
  if (!principal) {
    return c.json({ error: "not_found" }, 404);
  }
  const identities =
    await ctx.repos.externalIdentities.listByPrincipal(principalId);
  const body = PrincipalMeResponseSchema.parse({
    id: principal.id,
    state: principal.state,
    assurance: principal.assurance,
    createdAt: principal.createdAt.toISOString(),
    updatedAt: principal.updatedAt.toISOString(),
    ...(principal.verifiedAt
      ? { verifiedAt: principal.verifiedAt.toISOString() }
      : undefined),
    version: principal.version,
    identities: identities.map((i) => ({
      id: i.id,
      kind: i.kind,
      issuer: i.issuer,
      ...(i.displayHint !== undefined
        ? { displayHint: i.displayHint }
        : undefined),
      assurance: i.assurance,
    })),
  });
  return c.json(body);
});

principalRoutes.get("/identities", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const identities =
    await ctx.repos.externalIdentities.listByPrincipal(principalId);
  const body = IdentityListResponseSchema.parse({
    identities: identities.map((i) => ({
      id: i.id,
      kind: i.kind,
      issuer: i.issuer,
      subject: i.subject,
      ...(i.displayHint !== undefined
        ? { displayHint: i.displayHint }
        : undefined),
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
    const principalId = authenticatedPrincipalId(c.get("principalId"));
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

    // A verified upstream `id_token` is the production claim path (ADR 0033).
    // Self-asserted issuer/subject tuples prove nothing and stay a dev seam.
    if ("idToken" in parsed.data) {
      return linkFromVerifiedIdToken(
        c,
        principal,
        principalId,
        parsed.data.idToken,
      );
    }

    if (!ctx.config.allowDevDefaults) {
      return c.json(
        {
          error: "identity_link_requires_upstream",
          hint: "Complete an upstream authentication ceremony; self-asserted identity links are dev-only",
        },
        403,
      );
    }

    const existing = await ctx.repos.externalIdentities.findByTuple({
      kind: parsed.data.kind,
      issuer: parsed.data.issuer,
      ...(parsed.data.tenant !== undefined
        ? { tenant: parsed.data.tenant }
        : undefined),
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
                : undefined),
              assurance: existing.assurance,
              linkedAt: existing.linkedAt.toISOString(),
            },
          }),
        );
      }
      // Deliberately does not echo the bound principal id: that would let any
      // caller enumerate which principal owns an upstream identity.
      return c.json(
        {
          error: "identity_collision",
          message:
            "External identity already bound to another principal; merge requires dual authentication",
        },
        409,
      );
    }

    // Same email on another principal must never auto-link.
    if (parsed.data.emailNormalized) {
      const emailPeers =
        await ctx.repos.externalIdentities.listByEmailNormalized(
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
      ...(parsed.data.tenant !== undefined
        ? { tenant: parsed.data.tenant }
        : undefined),
      ...(parsed.data.displayHint !== undefined
        ? { displayHint: parsed.data.displayHint }
        : undefined),
      ...(parsed.data.emailNormalized !== undefined
        ? { emailNormalized: parsed.data.emailNormalized }
        : undefined),
      ...(parsed.data.emailVerified !== undefined
        ? { emailVerified: parsed.data.emailVerified }
        : undefined),
    };

    try {
      await ctx.repos.externalIdentities.create(identity);
    } catch (err) {
      if (err instanceof ConflictError) {
        return c.json(
          { error: "identity_collision", message: err.message },
          409,
        );
      }
      throw err;
    }

    if (
      principal.assurance === "provisional" ||
      principal.state === "provisional"
    ) {
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
            : undefined),
          assurance: identity.assurance,
          linkedAt: identity.linkedAt.toISOString(),
        },
      }),
      201,
    );
  },
);

function issuerKey(issuer: string): string {
  return issuer.trim().replace(/\/+$/, "");
}

async function linkFromVerifiedIdToken(
  c: Context<{ Variables: Variables }>,
  principal: Principal,
  principalId: string,
  idToken: string,
) {
  const ctx = c.get("ctx");
  let issuer = "";
  try {
    const claims = decodeJwt(idToken);
    issuer = typeof claims.iss === "string" ? issuerKey(claims.iss) : "";
  } catch {
    return c.json({ error: "invalid_token", message: "Not a JWT." }, 400);
  }
  const trusted = ctx.config.trustedUpstreamIssuers.map(issuerKey);
  if (!issuer || !trusted.includes(issuer)) {
    return c.json(
      {
        error: "untrusted_issuer",
        message: "That identity issuer is not in the allowlist.",
      },
      403,
    );
  }

  let subject: string;
  try {
    const verified = await verifyOrgIdToken(idToken, issuer);
    subject = verified.sub;
  } catch (error) {
    if (error instanceof OrgAssertionError) {
      const status = error.code === "upstream_unavailable" ? 502 : 401;
      return c.json({ error: error.code, message: error.message }, status);
    }
    throw error;
  }

  const existing = await ctx.repos.externalIdentities.findByTuple({
    kind: "oidc",
    issuer,
    subject,
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
              : undefined),
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
      },
      409,
    );
  }

  const now = ctx.clock();
  const identity: ExternalIdentity = {
    id: `xid_${randomUUID()}`,
    principalId,
    kind: "oidc",
    issuer,
    subject,
    assurance: "verified",
    linkedAt: now,
    metadata: {},
  };
  try {
    await ctx.repos.externalIdentities.create(identity);
  } catch (err) {
    if (err instanceof ConflictError) {
      return c.json({ error: "identity_collision", message: err.message }, 409);
    }
    throw err;
  }

  if (
    principal.assurance === "provisional" ||
    principal.state === "provisional"
  ) {
    await ctx.repos.principals.update(
      principalId,
      {
        state: "active",
        assurance: "verified",
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
      via: "id_token",
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
        assurance: identity.assurance,
        linkedAt: identity.linkedAt.toISOString(),
      },
    }),
    201,
  );
}

principalRoutes.delete("/identities/:id", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
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

/**
 * Host-plane mapping resolve (ADR 0042).
 *
 * Looks up canonical principal by upstream issuer + subject only.
 * Email is never accepted as a join key — requests that send `email` are denied.
 * Authenticated with OPENSESAME_MAPPING_RESOLVE_TOKEN (service secret), not a user session.
 */
principalRoutes.get("/mapping/resolve", async (c) => {
  const ctx = c.get("ctx");
  const expected = ctx.config.mappingResolveToken;
  if (!expected) {
    return c.json({ error: "mapping_resolve_disabled" }, 503);
  }
  const auth = c.req.header("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";
  const headerToken = c.req.header("x-opensesame-mapping-token")?.trim() ?? "";
  const presented = bearer || headerToken;
  if (!presented || !tokenEq(presented, expected)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const email = c.req.query("email")?.trim();
  if (email) {
    return c.json(
      {
        error: "email_join_forbidden",
        message: "Principal mapping resolve never joins by email",
      },
      400,
    );
  }

  const issuer = c.req.query("issuer")?.trim() ?? "";
  const subject = c.req.query("subject")?.trim() ?? "";
  const kind = c.req.query("kind")?.trim() || "oidc";
  if (!issuer || !subject) {
    return c.json(
      { error: "validation_error", message: "issuer and subject are required" },
      400,
    );
  }

  const fromMappings = await ctx.mappings.findByUpstream(issuer, subject);
  if (fromMappings) {
    return c.json({
      principalId: fromMappings.principalId,
      provisional: fromMappings.provisional,
      assurance: fromMappings.provisional ? "provisional" : "verified",
      issuer,
      subject,
    });
  }

  const identity = await ctx.repos.externalIdentities.findByTuple({
    kind,
    issuer,
    subject,
  });
  if (!identity) {
    return c.json({ error: "not_found" }, 404);
  }

  const principal = await ctx.repos.principals.getById(identity.principalId);
  const provisional =
    principal?.state === "provisional" ||
    principal?.assurance === "provisional";

  return c.json({
    principalId: identity.principalId,
    provisional: Boolean(provisional),
    assurance: principal?.assurance ?? identity.assurance,
    issuer: identity.issuer,
    subject: identity.subject,
  });
});

function tokenEq(presented: string, expected: string): boolean {
  const left = createHash("sha256").update(presented).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}
