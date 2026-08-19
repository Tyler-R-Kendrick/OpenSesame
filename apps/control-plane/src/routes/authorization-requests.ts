import { createHash, randomBytes } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import {
  AuthorizationRequestResponseSchema,
  CreateAuthorizationRequestSchema,
  DecideAuthorizationRequestSchema,
} from "@opensesame/contracts";
import {
  type PollIntervalState,
  applySlowDown,
  initialPollInterval,
} from "@opensesame/device-auth";
import {
  type AuthorizationRequest,
  DomainError,
  maybeExpire,
  settle,
} from "@opensesame/os-domain";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppContext } from "../context.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { authenticatedPrincipalId } from "./organizations.js";

/**
 * The authorization-request inbox (ADR 0046).
 *
 * A request waits here for a human — or, later, an envelope-bounded agent — to
 * allow or refuse it. Two properties do the security work:
 *
 * 1. Every response carries `requestDigest`, the canonical hash of exactly what
 *    is being consented to, and a decision must echo it back. An executor
 *    compares its own digest before running anything, so approving one request
 *    can never authorize a different one (PSD2 dynamic linking, applied to API
 *    calls).
 * 2. An inbox is only ever the caller's own. Reading or settling someone
 *    else's request answers 404 rather than 403: the id space must not be
 *    enumerable either.
 */

const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_INTERVAL_SECONDS = 5;

/** Poll attempts tolerated per request before the caller is slowed down. */
const POLL_STATE = new Map<
  string,
  { interval: PollIntervalState; lastPolledAt: number }
>();

function newRequestId(): string {
  return `areq_${randomBytes(18).toString("base64url")}`;
}

/**
 * The digest an approval is bound to.
 *
 * Canonical: the fields are hashed in a fixed order with their lengths, so two
 * different requests cannot produce the same bytes by moving text across a
 * boundary.
 */
function requestDigest(input: {
  principalId: string;
  requesterRef: string;
  authorizationDetails: Record<string, unknown>[];
  bindingMessage: string;
  connectionId?: string;
  delegationId?: string;
}): string {
  const parts = [
    "opensesame:authorization-request:v1",
    input.principalId,
    input.requesterRef,
    JSON.stringify(input.authorizationDetails),
    input.bindingMessage,
    input.connectionId ?? "",
    input.delegationId ?? "",
  ];
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part)));
    hash.update("\0");
    hash.update(part);
  }
  return hash.digest("hex");
}

/**
 * An opaque handle for whoever is asking.
 *
 * The canonical principal id does not travel here: this value is shown in an
 * inbox and, once relay lands, crosses bus subjects that are not private
 * (ADR 0042 subject hygiene).
 */
function requesterRef(principalId: string, pepper: string): string {
  return `req_${createHash("sha256")
    .update(`opensesame:requester-ref:v1\0${pepper}\0${principalId}`)
    .digest("base64url")
    .slice(0, 24)}`;
}

function toResponse(request: AuthorizationRequest) {
  return AuthorizationRequestResponseSchema.parse({
    authReqId: request.id,
    status: request.status,
    bindingMessage: request.bindingMessage,
    requestDigest: request.requestDigest,
    authorizationDetails: request.authorizationDetails,
    expiresAt: request.expiresAt.toISOString(),
    intervalSeconds: request.intervalSeconds,
    ...(request.connectionId ? { connectionId: request.connectionId } : {}),
    ...(request.delegationId ? { delegationId: request.delegationId } : {}),
    ...(request.decidedAt
      ? { decidedAt: request.decidedAt.toISOString() }
      : {}),
    ...(request.decidedByKind ? { decidedByKind: request.decidedByKind } : {}),
  });
}

function domainErrorStatus(code: string): ContentfulStatusCode {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "EXPIRED":
      return 410;
    case "CONFLICT":
      return 409;
    default:
      return 422;
  }
}

export const authorizationRequestRoutes = new Hono<{ Variables: Variables }>();

/** Ask a principal to authorize something. */
authorizationRequestRoutes.post(
  "/",
  requirePrincipal(),
  idempotencyMiddleware("authorization_requests.create"),
  async (c) => {
    const ctx = c.get("ctx");
    const callerId = authenticatedPrincipalId(c.get("principalId"));
    const parsed = CreateAuthorizationRequestSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", detail: parsed.error.message },
        400,
      );
    }
    const body = parsed.data;

    const approver = await ctx.repos.principals.getById(body.principalId);
    if (!approver) {
      // Do not distinguish "no such principal" from "not one you may ask":
      // either answer would make the id space enumerable.
      return c.json({ error: "not_found" }, 404);
    }

    const now = ctx.clock();
    const ref = requesterRef(callerId, ctx.config.claimPepper);
    const digest = requestDigest({
      principalId: body.principalId,
      requesterRef: ref,
      authorizationDetails: body.authorizationDetails,
      bindingMessage: body.bindingMessage,
      ...(body.connectionId ? { connectionId: body.connectionId } : {}),
      ...(body.delegationId ? { delegationId: body.delegationId } : {}),
    });
    const request: AuthorizationRequest = {
      id: newRequestId(),
      principalId: body.principalId,
      requesterRef: ref,
      authorizationDetails: body.authorizationDetails,
      requestDigest: digest,
      bindingMessage: body.bindingMessage,
      status: "pending",
      intervalSeconds: DEFAULT_INTERVAL_SECONDS,
      ...(body.connectionId ? { connectionId: body.connectionId } : {}),
      ...(body.delegationId ? { delegationId: body.delegationId } : {}),
      createdAt: now,
      expiresAt: new Date(
        now.getTime() + (body.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000,
      ),
      version: 1,
    };
    const created = await ctx.repos.authorizationRequests.create(request);

    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "authority.invocation.requested",
      principalId: callerId,
      actorType: "human",
      outcome: "succeeded",
      correlationId: c.get("correlationId"),
      // Digest-shaped keys only: the redactor's deny pass runs before its
      // allowlist, so anything named like a token or a code is dropped.
      metadata: {
        authReqId: created.id,
        requestDigest: created.requestDigest,
        ...(created.connectionId ? { connectionId: created.connectionId } : {}),
        ...(created.delegationId ? { delegationId: created.delegationId } : {}),
      },
    });

    return c.json(toResponse(created), 201);
  },
);

/** The caller's own inbox. */
authorizationRequestRoutes.get("/", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const status = c.req.query("status");
  const rows = await ctx.repos.authorizationRequests.listForPrincipal(
    principalId,
    status === "pending" ||
      status === "approved" ||
      status === "denied" ||
      status === "expired" ||
      status === "cancelled"
      ? { status }
      : undefined,
  );
  const now = ctx.clock();
  return c.json({
    requests: rows.map((row) => toResponse(maybeExpire(row, now))),
  });
});

/**
 * Load a request the caller is entitled to see.
 *
 * Both the approver and the requester may read one — the requester is polling
 * for an answer — and nobody else learns it exists.
 */
async function loadForCaller(
  ctx: AppContext,
  id: string,
  callerId: string,
): Promise<AuthorizationRequest | null> {
  const row = await ctx.repos.authorizationRequests.getById(id);
  if (!row) return null;
  const callerRef = requesterRef(callerId, ctx.config.claimPepper);
  const maySee = row.principalId === callerId || row.requesterRef === callerRef;
  return maySee ? row : null;
}

authorizationRequestRoutes.get("/:id", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const callerId = authenticatedPrincipalId(c.get("principalId"));
  const row = await loadForCaller(ctx, c.req.param("id") ?? "", callerId);
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json(toResponse(maybeExpire(row, ctx.clock())));
});

/** Poll for an answer, paced like a device flow. */
authorizationRequestRoutes.get("/:id/poll", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const callerId = authenticatedPrincipalId(c.get("principalId"));
  const id = c.req.param("id") ?? "";
  const row = await loadForCaller(ctx, id, callerId);
  if (!row) return c.json({ error: "not_found" }, 404);

  const now = ctx.clock();
  const current = maybeExpire(row, now);
  if (current.status === "expired") {
    POLL_STATE.delete(id);
    return c.json({ error: "expired_request", status: "expired" }, 410);
  }

  // Same pacing rule as the device flow: a caller polling faster than the
  // interval it was given is slowed down rather than served.
  const state =
    POLL_STATE.get(id) ??
    ({
      interval: initialPollInterval(current.intervalSeconds),
      lastPolledAt: 0,
    } as const);
  const elapsedMs = now.getTime() - state.lastPolledAt;
  if (
    state.lastPolledAt > 0 &&
    elapsedMs < state.interval.intervalSeconds * 1000
  ) {
    const interval = applySlowDown(state.interval);
    POLL_STATE.set(id, { interval, lastPolledAt: now.getTime() });
    return c.json(
      { error: "slow_down", intervalSeconds: interval.intervalSeconds },
      400,
    );
  }
  POLL_STATE.set(id, {
    interval: state.interval,
    lastPolledAt: now.getTime(),
  });
  return c.json(toResponse(current));
});

/** Allow or refuse. Only the approver may, and only with the digest they saw. */
function decideRoute(status: "approved" | "denied") {
  return async (c: Context<{ Variables: Variables }>) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const id = c.req.param("id") ?? "";
    const parsed = DecideAuthorizationRequestSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", detail: parsed.error.message },
        400,
      );
    }
    const row = await ctx.repos.authorizationRequests.getById(id);
    // Only the approver decides. A requester who could settle their own
    // request would make the whole ceremony decorative.
    if (!row || row.principalId !== principalId) {
      return c.json({ error: "not_found" }, 404);
    }
    if (row.requestDigest !== parsed.data.requestDigest) {
      // What was shown is not what is stored: refuse rather than consent to
      // something the approver did not read.
      return c.json({ error: "digest_mismatch" }, 409);
    }

    try {
      const settled = settle(row, {
        status,
        decidedByPrincipalId: principalId,
        // Agent approval arrives through the registry ADR 0046 describes and
        // is not wired yet; anything settling here is a person.
        decidedByKind: "human",
        now: ctx.clock(),
      });
      const saved = await ctx.repos.authorizationRequests.updateWithVersion(
        id,
        row.version,
        {
          status: settled.status,
          ...(settled.decidedAt ? { decidedAt: settled.decidedAt } : {}),
          ...(settled.decidedByPrincipalId
            ? { decidedByPrincipalId: settled.decidedByPrincipalId }
            : {}),
          ...(settled.decidedByKind
            ? { decidedByKind: settled.decidedByKind }
            : {}),
        },
      );
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "authority.invocation.completed",
        principalId,
        actorType: "human",
        outcome: status === "approved" ? "succeeded" : "denied",
        correlationId: c.get("correlationId"),
        metadata: {
          authReqId: saved.id,
          requestDigest: saved.requestDigest,
          decidedByKind: saved.decidedByKind ?? "human",
          ...(saved.connectionId ? { connectionId: saved.connectionId } : {}),
        },
      });
      return c.json(toResponse(saved));
    } catch (e) {
      if (e instanceof DomainError) {
        return c.json(
          { error: e.code.toLowerCase() },
          domainErrorStatus(e.code),
        );
      }
      throw e;
    }
  };
}

authorizationRequestRoutes.post(
  "/:id/approve",
  requirePrincipal(),
  decideRoute("approved"),
);
authorizationRequestRoutes.post(
  "/:id/deny",
  requirePrincipal(),
  decideRoute("denied"),
);
