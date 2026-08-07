import type { ContentfulStatusCode } from "hono/utils/http-status";
import { Hono } from "hono";
import { appendAuditEvent } from "@opensesame/audit";
import {
  ClaimSessionResponseSchema,
  CompleteClaimRequestSchema,
  CreateClaimRequestSchema,
  CreateClaimResponseSchema,
  PresentClaimRequestSchema,
} from "@opensesame/contracts";
import {
  DomainError,
  parseClaimToken,
  type ClaimSession,
} from "@opensesame/os-domain";
import type { CompleteDecision } from "@opensesame/claims";
import {
  evaluateDevicePoll,
  initialPollInterval,
  applySlowDown,
} from "@opensesame/device-auth";
import type { Variables } from "../middleware/context.js";
import { requirePrincipal } from "../middleware/auth.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { claimPageSecurityHeaders } from "../middleware/security-headers.js";

function toClaimResponse(session: ClaimSession) {
  return ClaimSessionResponseSchema.parse({
    id: session.id,
    type: session.type,
    state: session.state,
    targetManifestDigest: session.targetManifestDigest,
    expiresAt: session.expiresAt.toISOString(),
    version: session.version,
    ...(session.completedByPrincipalId !== undefined
      ? { completedByPrincipalId: session.completedByPrincipalId }
      : {}),
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
    const principalId = c.get("principalId")!;
    const parsed = CreateClaimRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "validation_error", details: parsed.error.flatten() }, 400);
    }

    const created = await ctx.claims.createClaim({
      type: parsed.data.type,
      targetManifest: parsed.data.targetManifest,
      creatorPrincipalId: principalId,
      ...(parsed.data.ttlSeconds !== undefined
        ? { ttlMs: parsed.data.ttlSeconds * 1000 }
        : {}),
      ...(parsed.data.proofKeyJkt !== undefined
        ? { proofKeyJkt: parsed.data.proofKeyJkt }
        : {}),
      ...(parsed.data.requestedDestination !== undefined
        ? { requestedDestination: parsed.data.requestedDestination }
        : {}),
      ...(parsed.data.requestedGrant !== undefined
        ? { requestedGrant: parsed.data.requestedGrant }
        : {}),
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

claimRoutes.get("/:id", async (c) => {
  const ctx = c.get("ctx");
  const session = await ctx.claims.get(c.req.param("id"));
  if (!session) return c.json({ error: "not_found" }, 404);
  return c.json(toClaimResponse(session));
});

claimRoutes.post("/present", async (c) => {
  const ctx = c.get("ctx");
  const parsed = PresentClaimRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "validation_error", details: parsed.error.flatten() }, 400);
  }
  const parts = parseClaimToken(parsed.data.token);
  if (!parts) {
    return c.json({ error: "invalid_token" }, 401);
  }
  try {
    const session = await ctx.claims.presentClaim(parts.publicId, parsed.data.token);
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "claim.presented",
      outcome: "succeeded",
      claimId: session.id,
      ...(c.get("principalId") !== undefined
        ? { principalId: c.get("principalId") }
        : {}),
      correlationId: c.get("correlationId"),
      metadata: { action: "claim.present", state: session.state },
    });
    return c.json(toClaimResponse(session));
  } catch (err) {
    if (err instanceof DomainError) {
      return c.json({ error: err.code, message: err.message }, domainErrorStatus(err));
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
    const principalId = c.get("principalId")!;
    const id = c.req.param("id");
    const parsed = CompleteClaimRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "validation_error", details: parsed.error.flatten() }, 400);
    }

    // Ensure claim is in a completable state: present → authenticate → review if needed
    try {
      let session = await ctx.claims.get(id);
      if (!session) return c.json({ error: "not_found" }, 404);

      if (session.state === "pending") {
        return c.json({ error: "INVALID_TRANSITION", message: "Claim must be presented first" }, 422);
      }
      if (session.state === "presented") {
        session = await ctx.claims.authenticateClaim(id);
      }
      if (session.state === "authenticated") {
        await ctx.claims.reviewClaim(id, {
          acceptedItemIds: parsed.data.acceptedItemIds,
          ...(parsed.data.destination !== undefined
            ? { destination: parsed.data.destination }
            : {}),
        });
      }

      const idemHeader = c.req.header("idempotency-key");
      const decision: CompleteDecision = {
        acceptedItemIds: parsed.data.acceptedItemIds,
      };
      if (parsed.data.destination !== undefined) {
        decision.destination = parsed.data.destination;
      }
      if (parsed.data.idempotencyKey !== undefined) {
        decision.idempotencyKey = parsed.data.idempotencyKey;
      } else if (idemHeader) {
        decision.idempotencyKey = idemHeader;
      }

      const result = await ctx.claims.completeClaim(id, principalId, decision);

      // Preserve principal / project ids from target manifest on completion
      const manifest = result.session.targetManifest;
      const projectId =
        typeof manifest["projectId"] === "string" ? manifest["projectId"] : undefined;
      if (projectId) {
        const project = ctx.stores.projects.get(projectId);
        if (project && project.state === "provisional") {
          ctx.stores.projects.set(projectId, {
            ...project,
            state: "active",
            updatedAt: ctx.clock(),
            ownerPrincipalId: project.ownerPrincipalId ?? principalId,
          });
        }
      }
      const agentId =
        typeof manifest["agentId"] === "string" ? manifest["agentId"] : undefined;
      if (agentId) {
        const agent = ctx.stores.agents.get(agentId);
        if (agent && agent.state === "provisional") {
          ctx.stores.agents.set(agentId, { ...agent, state: "claimed" });
        }
      }

      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "claim.completed",
        outcome: "succeeded",
        principalId,
        claimId: id,
        ...(projectId !== undefined ? { projectId } : {}),
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
          principalId:
            typeof manifest["ownerPrincipalId"] === "string"
              ? manifest["ownerPrincipalId"]
              : principalId,
          ...(projectId !== undefined ? { projectId } : {}),
          ...(agentId !== undefined ? { agentId } : {}),
        },
      });
    } catch (err) {
      if (err instanceof DomainError) {
        return c.json({ error: err.code, message: err.message }, domainErrorStatus(err));
      }
      throw err;
    }
  },
);

claimRoutes.post("/:id/deny", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = c.get("principalId")!;
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
      return c.json({ error: err.code, message: err.message }, domainErrorStatus(err));
    }
    throw err;
  }
});

claimRoutes.get("/:id/poll", async (c) => {
  const ctx = c.get("ctx");
  const session = await ctx.claims.get(c.req.param("id"));
  if (!session) return c.json({ error: "not_found" }, 404);

  // Device-auth style poll projection for claim waiting clients
  const interval = initialPollInterval(5);
  const deviceLike = {
    id: session.id,
    clientId: "claim-poll",
    deviceCodeDigest: session.tokenDigest,
    userCodeDigest: session.userCodeDigest ?? session.tokenDigest,
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
  const ctx = c.get("ctx");
  const id = c.req.param("id");
  const session = await ctx.claims.get(id);
  const state = session?.state ?? "unknown";
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
    <p>Claim <code>${id}</code> is <strong>${state}</strong>.</p>
    <p>Present your claim token via the API or continue in the console.</p>
  </main>
</body>
</html>`;
  return c.html(html);
});
