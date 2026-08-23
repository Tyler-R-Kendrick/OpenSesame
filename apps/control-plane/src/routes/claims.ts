import { appendAuditEvent } from "@opensesame/audit";
import type { CompleteDecision } from "@opensesame/claims";
import {
  ClaimSessionResponseSchema,
  CompleteClaimRequestSchema,
  CreateClaimRequestSchema,
  CreateClaimResponseSchema,
  PresentClaimRequestSchema,
} from "@opensesame/contracts";
import {
  applySlowDown,
  evaluateDevicePoll,
  initialPollInterval,
} from "@opensesame/device-auth";
import {
  type ClaimItem,
  type ClaimSession,
  DomainError,
  type JsonObject,
  isString,
  overlapCast,
  parseClaimToken,
  verifyClaimToken,
  verifyUserCode,
} from "@opensesame/os-domain";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppContext } from "../context.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import {
  claimPageSecurityHeaders,
  escapeHtml,
} from "../middleware/security-headers.js";
import { serializeKeyed } from "../serialize.js";
import { getUsage } from "../state.js";
import { authenticatedPrincipalId } from "./organizations.js";

/** Wrong user codes tolerated per claim before approval is refused outright. */
const MAX_CLAIM_APPROVAL_ATTEMPTS = 5;

/**
 * Project a claim for the wire.
 *
 * `items` is always present. A client has to be able to tell "this claim
 * covers nothing" from "this server never said what it covers", because the
 * second one read as the first is how an item-bearing claim gets accepted
 * without anyone seeing what was in it. Nothing mints item-bearing claims
 * today, which is exactly why the empty array has to be explicit now rather
 * than after something does.
 */
function toClaimResponse(session: ClaimSession, items: ClaimItem[] = []) {
  return ClaimSessionResponseSchema.parse({
    id: session.id,
    type: session.type,
    state: session.state,
    targetManifestDigest: session.targetManifestDigest,
    expiresAt: session.expiresAt.toISOString(),
    version: session.version,
    items: items.map((item) => ({
      id: item.id,
      targetType: item.targetType,
      targetId: item.targetId,
      requestedAction: item.requestedAction,
      required: item.required,
      dependencies: item.dependencies,
      state: item.state,
    })),
    ...(session.completedByPrincipalId !== undefined
      ? { completedByPrincipalId: session.completedByPrincipalId }
      : undefined),
  });
}

/** Claim status surfaces require the claim bearer (id alone must not reveal state). */
function extractClaimToken(
  c: Context<{ Variables: Variables }>,
): string | null {
  const header = c.req.header("x-claim-token");
  if (header?.startsWith("osc_clm_")) return header;
  const auth = c.req.header("authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(osc_clm_\S+)$/i.exec(auth);
  return m?.[1] ?? null;
}

async function loadClaimWithToken(
  c: Context<{ Variables: Variables }>,
  id: string,
): Promise<ClaimSession | Response> {
  const token = extractClaimToken(c);
  if (!token) {
    return c.json(
      {
        error: "unauthorized",
        hint: "X-Claim-Token or Bearer osc_clm_… required",
      },
      401,
    );
  }
  const parts = parseClaimToken(token);
  if (!parts || parts.publicId !== id) {
    return c.json({ error: "invalid_claim_token" }, 401);
  }
  const ctx = c.get("ctx");
  const session = await ctx.claims.get(id);
  if (
    !session ||
    !verifyClaimToken(ctx.config.claimPepper, token, session.tokenDigest)
  ) {
    return c.json({ error: "invalid_claim_token" }, 401);
  }
  return session;
}

/** A refused approval is the event a reviewer needs; success alone shows nothing. */
async function auditClaimDenial(
  ctx: AppContext,
  input: {
    claimId: string;
    principalId: string;
    reason: string;
    correlationId?: string;
  },
): Promise<void> {
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "claim.complete",
    outcome: "denied",
    principalId: input.principalId,
    claimId: input.claimId,
    ...(input.correlationId !== undefined
      ? { correlationId: input.correlationId }
      : undefined),
    metadata: { action: "claim.complete", reason: input.reason },
  });
}

function domainErrorStatus(err: DomainError): ContentfulStatusCode {
  switch (err.code) {
    case "NOT_FOUND":
      return 404;
    case "EXPIRED":
      return 410;
    case "INVALID_TOKEN":
    case "INVALID_USER_CODE":
      return 401;
    case "CONFLICT":
      return 409;
    case "DEPENDENCY_CLOSURE":
    case "INVALID_TRANSITION":
    case "INVARIANT_VIOLATION":
    case "IMMUTABLE_FIELD":
      return 422;
    default:
      return 400;
  }
}

export const claimRoutes = new Hono<{ Variables: Variables }>();

claimRoutes.post(
  "/",
  requirePrincipal(),
  idempotencyMiddleware("claims.create"),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const parsed = CreateClaimRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }

    const principal = await ctx.repos.principals.getById(principalId);
    if (!principal) {
      return c.json({ error: "unauthorized" }, 401);
    }

    return serializeKeyed(
      ctx.stores.principalMutations,
      principalId,
      async () => {
        const now = ctx.clock();
        const liveClaims = ctx.claimStore.listSessions().filter((session) => {
          if (session.creatorPrincipalId !== principalId) return false;
          if (session.expiresAt <= now) return false;
          return (
            session.state !== "completed" &&
            session.state !== "denied" &&
            session.state !== "revoked" &&
            session.state !== "expired"
          );
        }).length;
        const decision = ctx.policy.evaluate(
          principal,
          {
            subject: {
              type: "principal",
              id: principal.id,
              assurance: principal.assurance,
            },
            action: "claim.create",
            resource: { type: "claim", id: "*" },
          },
          {
            ...(await getUsage(ctx.stores, principalId, now)),
            claims: liveClaims,
          },
        );
        if (decision.effect === "deny") {
          return c.json({ error: "forbidden", reasons: decision.reasons }, 403);
        }

        // Hono established JSON syntax and Zod bounded each record. Contextual
        // types retain that JSON-safe contract past Zod's `unknown` values.
        const targetManifest: JsonObject = overlapCast(
          parsed.data.targetManifest,
        );
        const requestedDestination: JsonObject | undefined =
          parsed.data.requestedDestination === undefined
            ? undefined
            : overlapCast(parsed.data.requestedDestination);
        const requestedGrant: JsonObject | undefined =
          parsed.data.requestedGrant === undefined
            ? undefined
            : overlapCast(parsed.data.requestedGrant);
        const created = await ctx.claims.createClaim({
          type: parsed.data.type,
          targetManifest,
          creatorPrincipalId: principalId,
          ...(parsed.data.ttlSeconds !== undefined
            ? { ttlMs: parsed.data.ttlSeconds * 1000 }
            : undefined),
          ...(parsed.data.proofKeyJkt !== undefined
            ? { proofKeyJkt: parsed.data.proofKeyJkt }
            : undefined),
          ...(requestedDestination ? { requestedDestination } : undefined),
          ...(requestedGrant ? { requestedGrant } : undefined),
        });

        await appendAuditEvent(ctx.repos.auditEvents, {
          eventType: "claim.created",
          outcome: "succeeded",
          principalId,
          claimId: created.session.id,
          correlationId: c.get("correlationId"),
          metadata: { action: "claim.create", type: parsed.data.type },
        });

        const body = CreateClaimResponseSchema.parse({
          claimId: created.session.id,
          claimToken: created.token,
          userCode: created.userCode,
          verificationUri: `${ctx.config.publicUrl}/v1/claims/${created.session.id}/verify`,
          expiresAt: created.session.expiresAt.toISOString(),
          targetManifestDigest: created.session.targetManifestDigest,
          pollIntervalSeconds: 5,
        });
        return c.json(body, 201);
      },
    );
  },
);

claimRoutes.get("/:id", async (c) => {
  const loaded = await loadClaimWithToken(c, c.req.param("id"));
  if (loaded instanceof Response) return loaded;
  return c.json(toClaimResponse(loaded));
});

claimRoutes.post("/present", async (c) => {
  const ctx = c.get("ctx");
  const parsed = PresentClaimRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { error: "validation_error", details: parsed.error.flatten() },
      400,
    );
  }
  const parts = parseClaimToken(parsed.data.token);
  if (!parts) {
    return c.json({ error: "invalid_token" }, 401);
  }
  try {
    const session = await ctx.claims.presentClaim(
      parts.publicId,
      parsed.data.token,
    );
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "claim.presented",
      outcome: "succeeded",
      claimId: session.id,
      ...(c.get("principalId") !== undefined
        ? { principalId: c.get("principalId") }
        : undefined),
      correlationId: c.get("correlationId"),
      metadata: { action: "claim.present", state: session.state },
    });
    return c.json(toClaimResponse(session));
  } catch (err) {
    if (err instanceof DomainError) {
      return c.json({ error: err.code }, domainErrorStatus(err));
    }
    throw err;
  }
});

claimRoutes.post(
  "/:id/complete",
  requirePrincipal(),
  idempotencyMiddleware("claims.complete"),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const id = c.req.param("id");
    const parsed = CompleteClaimRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }

    // Ensure claim is in a completable state: present → authenticate → review if needed
    try {
      let session = await ctx.claims.get(id);
      if (!session) return c.json({ error: "not_found" }, 404);

      // Approval is the human consent step. Being *some* authenticated principal
      // proves nothing about the device being claimed, so require the user code
      // it displayed, with a per-claim attempt fence behind it.
      const attempts = (ctx.stores.claimApprovalAttempts.get(id) ?? 0) + 1;
      ctx.stores.claimApprovalAttempts.set(id, attempts);
      if (attempts > MAX_CLAIM_APPROVAL_ATTEMPTS) {
        await auditClaimDenial(ctx, {
          claimId: id,
          principalId,
          reason: "too_many_attempts",
          correlationId: c.get("correlationId"),
        });
        return c.json({ error: "too_many_attempts" }, 429);
      }
      if (
        !session.userCodeDigest ||
        !verifyUserCode(
          ctx.config.claimPepper,
          id,
          parsed.data.userCode,
          session.userCodeDigest,
        )
      ) {
        await auditClaimDenial(ctx, {
          claimId: id,
          principalId,
          reason: "invalid_user_code",
          correlationId: c.get("correlationId"),
        });
        return c.json({ error: "invalid_user_code" }, 401);
      }
      ctx.stores.claimApprovalAttempts.delete(id);
      const claimToken =
        parsed.data.claimToken ?? extractClaimToken(c) ?? undefined;
      if (claimToken) {
        const parts = parseClaimToken(claimToken);
        if (
          !parts ||
          parts.publicId !== id ||
          !verifyClaimToken(
            ctx.config.claimPepper,
            claimToken,
            session.tokenDigest,
          )
        ) {
          await auditClaimDenial(ctx, {
            claimId: id,
            principalId,
            reason: "invalid_claim_token",
            correlationId: c.get("correlationId"),
          });
          return c.json({ error: "invalid_claim_token" }, 401);
        }
      }
      ctx.stores.claimApprovalAttempts.delete(id);

      if (session.state === "pending") {
        return c.json(
          {
            error: "INVALID_TRANSITION",
            message: "Claim must be presented first",
          },
          422,
        );
      }
      if (session.state === "presented") {
        session = await ctx.claims.authenticateClaim(id);
      }
      const destination: JsonObject | undefined = parsed.data.destination
        ? overlapCast(parsed.data.destination)
        : undefined;
      if (session.state === "authenticated") {
        await ctx.claims.reviewClaim(id, {
          acceptedItemIds: parsed.data.acceptedItemIds,
          ...(destination ? { destination } : undefined),
        });
      }

      const idemHeader = c.req.header("idempotency-key");
      const decision: CompleteDecision = {
        acceptedItemIds: parsed.data.acceptedItemIds,
      };
      if (destination !== undefined) {
        decision.destination = destination;
      }
      if (parsed.data.idempotencyKey !== undefined) {
        decision.idempotencyKey = parsed.data.idempotencyKey;
      } else if (idemHeader) {
        decision.idempotencyKey = idemHeader;
      }

      const result = await ctx.claims.completeClaim(id, principalId, decision);

      // Preserve principal / project ids from target manifest on completion
      const manifest = result.session.targetManifest;
      const projectId = isString(manifest.projectId)
        ? manifest.projectId
        : undefined;
      if (projectId) {
        const project = await ctx.stores.projects.get(projectId);
        if (
          project &&
          project.state === "provisional" &&
          (project.ownerPrincipalId === principalId ||
            project.ownerPrincipalId === undefined)
        ) {
          const now = ctx.clock();
          // A claim can be completed after the project it names has run out of
          // time. Activating it then would hand back a project that is past its
          // own TTL and that nothing will expire again.
          const lapsed =
            project.expiresAt !== undefined && project.expiresAt <= now;
          await ctx.stores.projects.set(projectId, {
            ...project,
            state: lapsed ? "expired" : "active",
            updatedAt: now,
            ownerPrincipalId: project.ownerPrincipalId ?? principalId,
          });
        }
      }
      const agentId = isString(manifest.agentId) ? manifest.agentId : undefined;
      if (agentId) {
        const agent = ctx.stores.agents.get(agentId);
        if (
          agent &&
          agent.state === "provisional" &&
          agent.ownerPrincipalId === principalId
        ) {
          ctx.stores.agents.set(agentId, { ...agent, state: "claimed" });
        }
      }

      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "claim.completed",
        outcome: "succeeded",
        principalId,
        claimId: id,
        ...(projectId !== undefined ? { projectId } : undefined),
        correlationId: c.get("correlationId"),
        metadata: {
          action: "claim.complete",
          state: result.session.state,
          won: result.won,
        },
      });

      return c.json({
        ...toClaimResponse(result.session),
        won: result.won,
        preserved: {
          principalId: isString(manifest.ownerPrincipalId)
            ? manifest.ownerPrincipalId
            : principalId,
          ...(projectId !== undefined ? { projectId } : undefined),
          ...(agentId !== undefined ? { agentId } : undefined),
        },
      });
    } catch (err) {
      if (err instanceof DomainError) {
        return c.json({ error: err.code }, domainErrorStatus(err));
      }
      throw err;
    }
  },
);

claimRoutes.post("/:id/deny", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  try {
    const existing = await ctx.claims.get(c.req.param("id"));
    if (!existing) return c.json({ error: "not_found" }, 404);
    if (existing.creatorPrincipalId !== principalId) {
      return c.json(
        { error: "forbidden", message: "Only the claim creator can deny" },
        403,
      );
    }
    const session = await ctx.claims.deny(c.req.param("id"));
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "claim.denied",
      outcome: "succeeded",
      principalId,
      claimId: session.id,
      correlationId: c.get("correlationId"),
      metadata: { action: "claim.deny", state: session.state },
    });
    return c.json(toClaimResponse(session));
  } catch (err) {
    if (err instanceof DomainError) {
      return c.json({ error: err.code }, domainErrorStatus(err));
    }
    throw err;
  }
});

claimRoutes.get("/:id/poll", async (c) => {
  const ctx = c.get("ctx");
  const loaded = await loadClaimWithToken(c, c.req.param("id"));
  if (loaded instanceof Response) return loaded;
  const session = loaded;

  // Device-auth style poll projection for claim waiting clients.
  // Digests stay off the wire; placeholders satisfy the poll interval state machine only.
  const interval = initialPollInterval(5);
  const deviceLike = {
    id: session.id,
    clientId: "claim-poll",
    deviceCodeDigest: new Uint8Array(32),
    userCodeDigest: new Uint8Array(32),
    requestedScopes: ["openid"],
    requestedResources: [],
    state:
      session.state === "completed"
        ? ("approved" as const)
        : session.state === "denied" || session.state === "revoked"
          ? ("denied" as const)
          : session.state === "expired"
            ? ("expired" as const)
            : ("pending" as const),
    intervalSeconds: interval.intervalSeconds,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    pollCount: 0,
  };

  const poll = evaluateDevicePoll(deviceLike, ctx.clock);
  if (poll.error === "slow_down") {
    const slowed = applySlowDown(interval);
    return c.json(
      {
        status: session.state,
        error: poll.error,
        interval: slowed.intervalSeconds,
        claim: toClaimResponse(session),
      },
      400,
    );
  }
  if (poll.error) {
    return c.json(
      {
        status: session.state,
        error: poll.error,
        interval: interval.intervalSeconds,
        claim: toClaimResponse(session),
      },
      session.state === "expired" ? 410 : 400,
    );
  }

  return c.json({
    status: session.state,
    interval: interval.intervalSeconds,
    claim: toClaimResponse(session),
  });
});

claimRoutes.get("/:id/verify", claimPageSecurityHeaders(), async (c) => {
  // Verification landing page is reached by URL alone, so it must not disclose
  // whether the claim exists or its state — approval happens in the console.
  const id = c.req.param("id");
  const safeId = escapeHtml(id);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>OpenSesame Claim</title>
  <style>
    body{font-family:system-ui,sans-serif;margin:2rem;background:#0f1419;color:#e7ecf3}
    main{max-width:32rem}
    code{background:#1c2430;padding:.1rem .35rem;border-radius:4px}
  </style>
</head>
<body>
  <main>
    <h1>OpenSesame</h1>
    <p>Continue claim <code>${safeId}</code> in the console.</p>
    <p>Approving requires signing in and entering the user code shown by your device.</p>
  </main>
</body>
</html>`;
  return c.html(html);
});
