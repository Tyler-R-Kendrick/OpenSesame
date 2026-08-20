import { appendAuditEvent } from "@opensesame/audit";
import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { AppClaimService, ClaimError } from "../services/app-claim.js";
import { authenticatedPrincipalId } from "./organizations.js";

export const appClaimRoutes = new Hono<{ Variables: Variables }>();

function claimService(ctx: AppContext): AppClaimService {
  return new AppClaimService({
    clientStore: ctx.stores.oauthClients,
    challengeStore: ctx.stores.clientClaimChallenges,
    clientOriginStore: ctx.stores.clientOrigins,
    issuer: ctx.config.issuer,
    systemOwnerPrincipalId: ctx.systemOwnerPrincipalId,
    clock: ctx.clock,
    isProduction: ctx.config.isProduction,
    // Loopback static sites cannot pass the SSRF-pinned fetcher; direct proof
    // fetch is a development-only posture (ADR 0050 F5).
    allowDirectFetch: !ctx.config.isProduction,
  });
}

/** Claiming transfers ownership — it requires a verified identity. */
async function assertVerified(
  ctx: AppContext,
  principalId: string,
): Promise<Response | null> {
  const principal = await ctx.repos.principals.getById(principalId);
  if (!principal) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (principal.assurance === "provisional") {
    return Response.json(
      {
        error: "assurance_too_low",
        message: "Verified identity required to claim OAuth applications",
      },
      { status: 403 },
    );
  }
  return null;
}

appClaimRoutes.post(
  "/:id/claim/start",
  requirePrincipal(),
  idempotencyMiddleware("oauth-applications.claim.start"),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const denied = await assertVerified(ctx, principalId);
    if (denied) return denied;

    const body = (await c.req.json().catch(() => ({}))) as {
      origin?: string;
    };
    try {
      const started = await claimService(ctx).startClaim({
        applicationId: c.req.param("id"),
        ownerPrincipalId: principalId,
        ...(body.origin !== undefined ? { origin: body.origin } : {}),
      });
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "oauth_client.claim_challenge_started",
        outcome: "succeeded",
        principalId,
        clientId: started.document.application_id,
        correlationId: c.get("correlationId"),
        metadata: {
          action: "oauth_client.claim_start",
          origin: started.document.origin,
        },
      });
      return c.json(
        {
          challengeId: started.challengeId,
          challenge: started.challenge,
          wellKnownUrl: started.wellKnownUrl,
          expiresAt: started.expiresAt.toISOString(),
          document: started.document,
        },
        201,
      );
    } catch (err) {
      if (err instanceof ClaimError) {
        return c.json(
          { error: err.code, message: err.message },
          err.status as 400,
        );
      }
      throw err;
    }
  },
);

appClaimRoutes.post(
  "/:id/claim/verify",
  requirePrincipal(),
  idempotencyMiddleware("oauth-applications.claim.verify"),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const denied = await assertVerified(ctx, principalId);
    if (denied) return denied;

    const body = (await c.req.json().catch(() => ({}))) as {
      challenge?: string;
      origin?: string;
      attachAlias?: boolean;
    };
    if (!body.challenge) {
      return c.json(
        { error: "validation_error", message: "challenge is required" },
        400,
      );
    }
    try {
      const result = await claimService(ctx).verifyAndClaim({
        challenge: body.challenge,
        ownerPrincipalId: principalId,
        ...(body.origin !== undefined ? { origin: body.origin } : {}),
        ...(body.attachAlias !== undefined
          ? { attachAlias: body.attachAlias }
          : {}),
      });
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "oauth_client.claimed",
        outcome: "succeeded",
        principalId,
        clientId: result.applicationId,
        correlationId: c.get("correlationId"),
        metadata: {
          action: "oauth_client.claim_verify",
          origin: result.origin,
          aliasAttached: result.aliasAttached,
        },
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof ClaimError) {
        return c.json(
          { error: err.code, message: err.message },
          err.status as 400,
        );
      }
      throw err;
    }
  },
);
