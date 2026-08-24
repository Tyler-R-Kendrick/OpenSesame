import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import {
  AuthorizationRequestResponseSchema,
  CreateAuthorizationRequestSchema,
  DecideAuthorizationRequestSchema,
} from "@opensesame/contracts";
import { ConflictError, NotFoundError } from "@opensesame/database";
import {
  type PollIntervalState,
  applySlowDown,
  initialPollInterval,
} from "@opensesame/device-auth";
import {
  type AuthorizationRequest,
  DomainError,
  type JsonObject,
  maybeExpire,
  overlapCast,
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
 * 3. An inbox is *addressed* by a handle, not by a principal id. Knowing who
 *    someone is must not be enough to put text in front of them, and the
 *    answer to "does this principal exist?" must not be obtainable by asking
 *    them for something. See `inboxRef`.
 */

const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_INTERVAL_SECONDS = 5;

interface AuthorizationPollState {
  interval: PollIntervalState;
  lastPolledAt: number;
}

interface AuthorizationDigestInput {
  principalId: string;
  requesterRef: string;
  authorizationDetails: JsonObject[];
  bindingMessage: string;
  connectionId?: string;
  delegationId?: string;
}

/**
 * Pacing state per request, for `slow_down`.
 *
 * Process-local on purpose and *only* a courtesy: it paces a well-behaved
 * client and blunts a hot loop, but a caller spread across instances is not
 * paced by it. Anything load-bearing belongs in the store, not here — which is
 * why nothing security-relevant is decided from this map.
 *
 * Bounded, because an unbounded module-global keyed by attacker-creatable ids
 * is a slow leak. Entries are dropped when a request reaches a terminal state,
 * and the oldest are evicted if the map still grows past its cap.
 */
const MAX_POLL_STATE_ENTRIES = 10_000;
const POLL_STATE = new Map<string, AuthorizationPollState>();

function rememberPollState(id: string, state: AuthorizationPollState): void {
  // Re-inserting moves the key to the back of Map's insertion order, so the
  // eviction below sheds the least recently polled request.
  POLL_STATE.delete(id);
  POLL_STATE.set(id, state);
  while (POLL_STATE.size > MAX_POLL_STATE_ENTRIES) {
    const oldest = POLL_STATE.keys().next();
    if (oldest.done) break;
    POLL_STATE.delete(oldest.value);
  }
}

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
function requestDigest(input: AuthorizationDigestInput): string {
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

/**
 * The handle that addresses an inbox.
 *
 * Asking someone to authorize something is not a public affordance. If a raw
 * principal id were the address, then anyone who learned an id could put
 * attacker-authored text in front of that person, and the difference between
 * "accepted" and "no such principal" would answer, for any id, whether it
 * exists. Neither is acceptable for a surface whose whole job is to be trusted
 * when it says "someone is asking".
 *
 * So the address is a handle: the principal id carried under an HMAC keyed by
 * the deployment pepper. It cannot be minted for an id the caller has not been
 * given a handle for, which makes *knowing the handle* the authorization to
 * ask — the same shape as the claim links this service already hands out. A
 * handle that does not verify and a handle for a principal that no longer
 * exists both answer 404, so there is no oracle left to query.
 */
function inboxRef(principalId: string, pepper: string): string {
  const body = Buffer.from(principalId, "utf8").toString("base64url");
  const tag = createHmac("sha256", pepper)
    .update(`opensesame:inbox-ref:v1\0${principalId}`)
    .digest("base64url")
    .slice(0, 32);
  return `inbox_${body}.${tag}`;
}

/** The principal a handle addresses, or null if it was not minted here. */
function resolveInboxRef(ref: string, pepper: string): string | null {
  if (!ref.startsWith("inbox_")) return null;
  const [body, tag] = ref.slice("inbox_".length).split(".");
  if (!body || !tag) return null;
  let principalId: string;
  try {
    principalId = Buffer.from(body, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!principalId) return null;
  const expected = inboxRef(principalId, pepper);
  // Constant-time: the tag is a MAC, and comparing it byte-by-byte with an
  // early exit is a forgery oracle for a caller who can time the answer.
  const a = Buffer.from(ref, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return principalId;
}

/**
 * Persist an expiry that was observed on read.
 *
 * `maybeExpire` is a pure projection: without this, a lapsed request stays
 * `pending` in the store forever, holds a place in the approver's bounded
 * inbox ahead of live requests, and leaves the table with nothing that ever
 * sheds it. Racing writers are expected — whoever settles it first wins, and a
 * conflict here means someone already did.
 */
async function persistExpiry(
  ctx: AppContext,
  row: AuthorizationRequest,
  now: Date,
): Promise<AuthorizationRequest> {
  const projected = maybeExpire(row, now);
  if (projected.status !== "expired" || row.status === "expired") {
    return projected;
  }
  try {
    return await ctx.repos.authorizationRequests.updateWithVersion(
      row.id,
      row.version,
      { status: "expired" },
    );
  } catch {
    // Losing the race is the normal outcome, not a failure: the caller is
    // shown the projection either way.
    return projected;
  }
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
    ...(request.connectionId
      ? { connectionId: request.connectionId }
      : undefined),
    ...(request.delegationId
      ? { delegationId: request.delegationId }
      : undefined),
    ...(request.decidedAt
      ? { decidedAt: request.decidedAt.toISOString() }
      : undefined),
    ...(request.decidedByKind
      ? { decidedByKind: request.decidedByKind }
      : undefined),
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
    // The HTTP JSON parser establishes JSON-safe values; Zod establishes the
    // bounded authorization-detail object shape while preserving RFC 9396
    // extension members.
    const authorizationDetails: JsonObject[] = body.authorizationDetails.map(
      (detail) => overlapCast(detail),
    );

    // Knowing the handle is what authorizes the asking. A handle that does not
    // verify, and one that verifies for a principal that is gone or not
    // accepting requests, answer identically: nothing here confirms an id.
    const approverId = resolveInboxRef(
      body.approverRef,
      ctx.config.claimPepper,
    );
    const approver = approverId
      ? await ctx.repos.principals.getById(approverId)
      : null;
    if (
      !approverId ||
      !approver ||
      approver.state === "suspended" ||
      approver.state === "closed"
    ) {
      // A provisional principal is still a legitimate approver — a guest can
      // hold delegated authority — so the state check only refuses principals
      // that must not be asked at all. Being asked is gated by the handle,
      // not by assurance.
      return c.json({ error: "not_found" }, 404);
    }

    const now = ctx.clock();
    const ref = requesterRef(callerId, ctx.config.claimPepper);
    const digest = requestDigest({
      principalId: approverId,
      requesterRef: ref,
      authorizationDetails,
      bindingMessage: body.bindingMessage,
      ...(body.connectionId ? { connectionId: body.connectionId } : undefined),
      ...(body.delegationId ? { delegationId: body.delegationId } : undefined),
    });
    const request: AuthorizationRequest = {
      id: newRequestId(),
      principalId: approverId,
      requesterRef: ref,
      authorizationDetails,
      requestDigest: digest,
      bindingMessage: body.bindingMessage,
      status: "pending",
      intervalSeconds: DEFAULT_INTERVAL_SECONDS,
      ...(body.connectionId ? { connectionId: body.connectionId } : undefined),
      ...(body.delegationId ? { delegationId: body.delegationId } : undefined),
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
        ...(created.connectionId
          ? { connectionId: created.connectionId }
          : undefined),
        ...(created.delegationId
          ? { delegationId: created.delegationId }
          : undefined),
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
  const projected = await Promise.all(
    rows.map((row) => persistExpiry(ctx, row, now)),
  );
  return c.json({ requests: projected.map(toResponse) });
});

/**
 * The caller's own inbox handle, to share with whoever may ask them.
 *
 * Issued only to its owner: this is the one place a handle comes from, so a
 * caller can never obtain someone else's.
 */
authorizationRequestRoutes.get("/inbox-ref", requirePrincipal(), (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  return c.json({ approverRef: inboxRef(principalId, ctx.config.claimPepper) });
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
  return c.json(toResponse(await persistExpiry(ctx, row, ctx.clock())));
});

/** Poll for an answer, paced like a device flow. */
authorizationRequestRoutes.get("/:id/poll", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const callerId = authenticatedPrincipalId(c.get("principalId"));
  const id = c.req.param("id") ?? "";
  const row = await loadForCaller(ctx, id, callerId);
  if (!row) return c.json({ error: "not_found" }, 404);

  const now = ctx.clock();
  const current = await persistExpiry(ctx, row, now);
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
    rememberPollState(id, { interval, lastPolledAt: now.getTime() });
    return c.json(
      { error: "slow_down", intervalSeconds: interval.intervalSeconds },
      400,
    );
  }
  if (current.status === "pending") {
    rememberPollState(id, {
      interval: state.interval,
      lastPolledAt: now.getTime(),
    });
  } else {
    // Settled: there is nothing further to pace, and keeping the entry would
    // retain one per request for the life of the process.
    POLL_STATE.delete(id);
  }
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
          ...(settled.decidedAt ? { decidedAt: settled.decidedAt } : undefined),
          ...(settled.decidedByPrincipalId
            ? { decidedByPrincipalId: settled.decidedByPrincipalId }
            : undefined),
          ...(settled.decidedByKind
            ? { decidedByKind: settled.decidedByKind }
            : undefined),
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
          ...(saved.connectionId
            ? { connectionId: saved.connectionId }
            : undefined),
        },
      });
      POLL_STATE.delete(id);
      return c.json(toResponse(saved));
    } catch (e) {
      if (e instanceof DomainError) {
        return c.json(
          { error: e.code.toLowerCase() },
          domainErrorStatus(e.code),
        );
      }
      // Two approvers racing, or one person double-clicking Approve: the row
      // moved under us. That is a conflict the caller can act on, not an
      // internal error — and a 500 here would look like the decision may have
      // landed when it did not.
      if (e instanceof ConflictError) {
        return c.json({ error: "conflict" }, 409);
      }
      if (e instanceof NotFoundError) {
        return c.json({ error: "not_found" }, 404);
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
