import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import { issueTransactionChallenge } from "@opensesame/auth-upstream";
import {
  ApprovalReceiptResponseSchema,
  ApprovalRequirementResponseSchema,
  AuthorizationRequestResponseSchema,
  BeginApprovalActivationResponseSchema,
  BeginApprovalActivationSchema,
  ComparisonChallengeResponseSchema,
  CompleteApprovalActivationSchema,
  CreateAuthorizationRequestSchema,
  DecideAuthorizationRequestSchema,
  SettleAuthorizationRequestSchema,
} from "@opensesame/contracts";
import { ConflictError } from "@opensesame/database";
import {
  type PollIntervalState,
  applySlowDown,
  initialPollInterval,
} from "@opensesame/device-auth";
import {
  type ApprovalActivation,
  type AuthenticationFacts,
  type AuthorizationRequest,
  COMPARISON_DIGITS,
  COMPARISON_MAX_ATTEMPTS,
  type JsonObject,
  approvalTransactionDigest,
  authorizationRequestDigest,
  channelAuthenticationCeiling,
  digestsEqual,
  evaluateComparison,
  isString,
  maybeExpire,
  overlapCast,
} from "@opensesame/os-domain";
import {
  evaluateApprovalCeremony,
  requiredReasonCodes,
} from "@opensesame/trust-broker";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppContext } from "../context.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import {
  activationAuthenticationFacts,
  comparisonValueDigest,
  principalEvidence,
  recordSettlement,
  webAuthnRpFromPublicUrl,
} from "./approval-ceremony.js";
import { resolveApprovalPolicy } from "./approval-policy.js";
import { authenticatedPrincipalId } from "./organizations.js";

/**
 * The authorization-request inbox (ADR 0046, ADR 0084).
 *
 * A request waits here for a human — or, later, an envelope-bounded agent — to
 * allow or refuse it. Four properties do the security work:
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
 * 4. Consent is a *transaction*, not a button press. What the request asks
 *    for decides which policy applies, the policy decides whether a fresh,
 *    transaction-bound authenticator ceremony is required, and the ceremony
 *    is checked against the same digest at settlement. `evaluateApprovalCeremony`
 *    in `@opensesame/trust-broker` is the only place that decides whether a
 *    decision may stand; this file gathers facts for it and records what it
 *    said.
 */

const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_INTERVAL_SECONDS = 5;

/**
 * Anti-fatigue budgets (ADR 0046 decision 9).
 *
 * The store is the budget, not a module-global: a counter one replica keeps
 * is a counter the next replica does not enforce, and "how many times may
 * this requester interrupt this person?" is exactly the question an attacker
 * asks in parallel. Every number below is counted from
 * `authorizationRequests` rows, which every instance shares.
 */
const PROMPT_WINDOW_MS = 5 * 60_000;
const MAX_PROMPTS_PER_APPROVER = 20;
const MAX_PROMPTS_PER_REQUESTER_PAIR = 5;
const PROMPT_SCAN_LIMIT = 100;

/** How long a minted activation may sit unspent, before the policy's own bound. */
const MAX_ACTIVATION_TTL_SECONDS = 300;
const COMPARISON_TTL_SECONDS = 300;
/** Base64 fields on an assertion: bounded so a body cannot be a denial of service. */
const MAX_ASSERTION_FIELD_LENGTH = 16 * 1024;

interface AuthorizationPollState {
  interval: PollIntervalState;
  lastPolledAt: number;
}

/**
 * Pacing state per request, for `slow_down`.
 *
 * Process-local on purpose and *only* a courtesy: it paces a well-behaved
 * client and blunts a hot loop, but a caller spread across instances is not
 * paced by it. Anything load-bearing belongs in the store, not here — which is
 * why nothing security-relevant is decided from this map, and why the prompt
 * budgets above are counted from rows instead. Keep it that way: the moment a
 * refusal depends on this map, the refusal stops applying to the second
 * replica.
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

/**
 * Project a request for a client.
 *
 * `approval` is a *summary*, computed from the same resolver settlement uses,
 * so an inbox can send a request that needs a ceremony to the review screen
 * rather than offering an Approve button the server will refuse. It is not
 * the gate and must never be read as one: the policy is resolved again at
 * decision time, because the answer can change between the list being drawn
 * and the button being pressed.
 */
function toResponse(request: AuthorizationRequest, ctx?: AppContext) {
  // Same resolver settlement uses, so the summary a client sees and the gate
  // it will meet cannot describe different policies.
  const resolved = ctx ? policyFor(ctx, request) : undefined;
  return AuthorizationRequestResponseSchema.parse({
    authReqId: request.id,
    requesterRef: request.requesterRef,
    ...(resolved
      ? {
          approval: {
            riskClass: resolved.policy.riskClass,
            requireTransactionBoundActivation:
              resolved.policy.requireTransactionBoundActivation,
            requireComparison: resolved.policy.requireComparison,
            required: requiredReasonCodes(resolved.policy),
          },
        }
      : undefined),
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

/** The policy this request is judged under, resolved from the row itself. */
function policyFor(ctx: AppContext, row: AuthorizationRequest) {
  return resolveApprovalPolicy({
    authorizationDetails: row.authorizationDetails,
    deployment: {
      directApprovalChannels: ctx.config.notifications.directApprovalChannels,
      directDenialChannels: ctx.config.notifications.directDenialChannels,
    },
  });
}

/**
 * The refusal a person is shown first.
 *
 * The evaluator collects every reason, which is right for an audit record and
 * wrong for a screen: told "assurance_insufficient" when the real problem is
 * that their authenticator touch expired, a person retries the wrong thing.
 * Activation and comparison refusals are actionable, so they win.
 */
function primaryRefusal(refusals: readonly string[]): string {
  return (
    refusals.find((r) => r.startsWith("activation_")) ??
    refusals.find((r) => r.startsWith("comparison_")) ??
    refusals[0] ??
    "approval_requirements_unmet"
  );
}

function refusalStatus(refusal: string): ContentfulStatusCode {
  if (refusal === "activation_expired") return 410;
  if (refusal.startsWith("activation_")) return 409;
  if (refusal === "request_not_pending") return 422;
  return 403;
}

/** Digest of the one challenge an activation was minted with. */
function challengeDigest(challenge: string): string {
  return `v1:${createHash("sha256")
    .update(`opensesame:activation-challenge:v1\0${challenge}`)
    .digest("hex")}`;
}

/** The challenge a WebAuthn client signed over, from its clientDataJSON. */
function challengeFromClientData(clientDataJSON: string): string | null {
  try {
    const parsed: { challenge?: string } = overlapCast(
      JSON.parse(Buffer.from(clientDataJSON, "base64").toString("utf8")),
    );
    const challenge = parsed.challenge;
    return challenge && isString(challenge) ? challenge : null;
  } catch {
    return null;
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
    const digest = authorizationRequestDigest({
      principalId: approverId,
      requesterRef: ref,
      authorizationDetails,
      bindingMessage: body.bindingMessage,
      ...(body.connectionId ? { connectionId: body.connectionId } : undefined),
      ...(body.delegationId ? { delegationId: body.delegationId } : undefined),
    });

    // Anti-fatigue, counted from the durable rows every replica shares.
    const recent = await ctx.repos.authorizationRequests.listForPrincipal(
      approverId,
      { limit: PROMPT_SCAN_LIMIT },
    );
    // The same question asked twice is one question. Returning the live row
    // rather than minting a second is the difference between a retry and a
    // second prompt for the same thing — and a person shown the same request
    // twice learns that prompts are noise.
    const duplicate = recent.find(
      (row) =>
        row.status === "pending" &&
        row.expiresAt.getTime() > now.getTime() &&
        row.requestDigest === digest,
    );
    if (duplicate) return c.json(toResponse(duplicate, ctx), 200);

    const windowStart = now.getTime() - PROMPT_WINDOW_MS;
    const inWindow = recent.filter(
      (row) => row.createdAt.getTime() >= windowStart,
    );
    if (inWindow.length >= MAX_PROMPTS_PER_APPROVER) {
      return c.json({ error: "prompt_rate_limited" }, 429);
    }
    if (
      inWindow.filter((row) => row.requesterRef === ref).length >=
      MAX_PROMPTS_PER_REQUESTER_PAIR
    ) {
      return c.json({ error: "prompt_rate_limited" }, 429);
    }

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

    // The outbox row is what the worker's webhook dispatcher fans out to the
    // approver's registered hooks (ADR 0046 decision 12). Digest-shaped keys
    // only, plus the approver id the dispatcher routes on — the inbox stays
    // the source of truth; a hook is a doorbell, not the door.
    await ctx.repos.outbox.append({
      id: randomBytes(16).toString("hex"),
      aggregateType: "authorization_request",
      aggregateId: created.id,
      eventType: "authority.invocation.requested",
      payload: {
        principalId: created.principalId,
        authReqId: created.id,
        requestDigest: created.requestDigest,
        expiresAt: created.expiresAt.toISOString(),
      },
    });

    return c.json(toResponse(created, ctx), 201);
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
  return c.json({ requests: projected.map((row) => toResponse(row, ctx)) });
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

/** Load a request only its approver may act on. 404 for everyone else. */
async function loadForApprover(
  ctx: AppContext,
  id: string,
  principalId: string,
): Promise<AuthorizationRequest | null> {
  const row = await ctx.repos.authorizationRequests.getById(id);
  if (!row || row.principalId !== principalId) return null;
  return row;
}

authorizationRequestRoutes.get("/:id", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const callerId = authenticatedPrincipalId(c.get("principalId"));
  const row = await loadForCaller(ctx, c.req.param("id") ?? "", callerId);
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json(toResponse(await persistExpiry(ctx, row, ctx.clock()), ctx));
});

/**
 * What this request will take to settle.
 *
 * Served to the approver before they decide, so the ceremony can be explicit
 * rather than one-tap. A screen that demands an authenticator touch without
 * saying why teaches people to touch authenticators when asked, which is the
 * habit every prompt-bombing campaign is built on.
 */
authorizationRequestRoutes.get(
  "/:id/requirement",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const row = await loadForApprover(
      ctx,
      c.req.param("id") ?? "",
      principalId,
    );
    if (!row) return c.json({ error: "not_found" }, 404);
    const { policy, policyDigest, riskClass } = policyFor(ctx, row);
    return c.json(
      ApprovalRequirementResponseSchema.parse({
        riskClass,
        policyDigest,
        requireTransactionBoundActivation:
          policy.requireTransactionBoundActivation,
        requireComparison: policy.requireComparison,
        required: requiredReasonCodes(policy),
        maximumApprovalAgeSeconds: policy.maximumApprovalAgeSeconds,
      }),
    );
  },
);

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
  return c.json(toResponse(current, ctx));
});

/* ------------------------------------------------------------------ *
 * The comparison ceremony
 * ------------------------------------------------------------------ */

/**
 * The comparison value, issued to the surface that *started* the request.
 *
 * Server-generated, with `randomInt` rather than anything derived from
 * `bindingMessage`: the binding message is requester-supplied text, and a
 * requester who chooses what the approver compares has not been asked to
 * compare anything.
 *
 * Returned exactly once. Only the digest is stored, so a second issue cannot
 * hand the value back — and must not, because a fresh code with a fresh
 * budget is a way to buy five more guesses per attempt. Re-issuing is refused
 * instead.
 */
authorizationRequestRoutes.get(
  "/:id/comparison",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const callerId = authenticatedPrincipalId(c.get("principalId"));
    const id = c.req.param("id") ?? "";
    const row = await ctx.repos.authorizationRequests.getById(id);
    const callerRef = requesterRef(callerId, ctx.config.claimPepper);
    // The requester's, and only the requester's: the point of the ceremony is
    // that the value travels from where the request started to where it is
    // approved. Handing it to the approver compares nothing.
    if (!row || row.requesterRef !== callerRef) {
      return c.json({ error: "not_found" }, 404);
    }
    const now = ctx.clock();
    if (row.status !== "pending" || row.expiresAt.getTime() <= now.getTime()) {
      return c.json({ error: "request_not_pending" }, 409);
    }
    const existing = await ctx.repos.comparisonChallenges.getForRequest(id);
    if (existing) {
      return c.json({ error: "comparison_already_issued" }, 409);
    }
    const value = String(randomInt(0, 10 ** COMPARISON_DIGITS)).padStart(
      COMPARISON_DIGITS,
      "0",
    );
    const expiresAt = new Date(
      Math.min(
        now.getTime() + COMPARISON_TTL_SECONDS * 1000,
        row.expiresAt.getTime(),
      ),
    );
    try {
      await ctx.repos.comparisonChallenges.create({
        id: `cmpc_${randomBytes(12).toString("base64url")}`,
        authReqId: id,
        valueDigest: comparisonValueDigest(id, value, ctx.config.claimPepper),
        attempts: 0,
        maxAttempts: COMPARISON_MAX_ATTEMPTS,
        createdAt: now,
        expiresAt,
        version: 1,
      });
    } catch (error) {
      // One challenge per request, enforced by the store's unique key. Two
      // issues racing must not both hand out a code with its own budget.
      if (error instanceof ConflictError) {
        return c.json({ error: "comparison_already_issued" }, 409);
      }
      throw error;
    }
    // Deliberately no audit metadata carrying the value, and no log line: the
    // plaintext exists in this response body and nowhere else in the system.
    return c.json(
      ComparisonChallengeResponseSchema.parse({
        authReqId: id,
        value,
        expiresAt: expiresAt.toISOString(),
      }),
    );
  },
);

/* ------------------------------------------------------------------ *
 * Transaction-bound activation
 * ------------------------------------------------------------------ */

/**
 * Mint a WebAuthn ceremony bound to one approval transaction.
 *
 * The digest the challenge is bound to commits to the request id, the request
 * digest, the approver, *the decision*, the effective policy and the channel.
 * Every one of those is a replay that would otherwise work: an activation for
 * request A presented against request B, one minted for "deny" spent as
 * "approve", one minted under yesterday's laxer policy.
 */
authorizationRequestRoutes.post(
  "/:id/activation",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const id = c.req.param("id") ?? "";
    const parsed = BeginApprovalActivationSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", detail: parsed.error.message },
        400,
      );
    }
    const row = await loadForApprover(ctx, id, principalId);
    if (!row) return c.json({ error: "not_found" }, 404);
    const now = ctx.clock();
    const current = await persistExpiry(ctx, row, now);
    if (current.status !== "pending") {
      return c.json({ error: "request_not_pending" }, 422);
    }
    // The digest the person read, not the one the row happens to hold now.
    if (!digestsEqual(current.requestDigest, parsed.data.requestDigest)) {
      return c.json({ error: "digest_mismatch" }, 409);
    }

    const { policy, policyDigest } = policyFor(ctx, current);
    const transactionDigest = approvalTransactionDigest({
      authReqId: current.id,
      requestDigest: current.requestDigest,
      approverPrincipalId: principalId,
      decision: parsed.data.decision,
      policyDigest,
      channelKind: "in_app",
    });
    const rp = webAuthnRpFromPublicUrl(ctx.config.publicUrl);
    const ttlSeconds = Math.min(
      policy.maximumApprovalAgeSeconds,
      MAX_ACTIVATION_TTL_SECONDS,
    );
    const { challenge, options } = await issueTransactionChallenge(
      ctx.passkeyChallenges,
      rp,
      { principalId, transactionDigest, ttlMs: ttlSeconds * 1000 },
    );
    const activation: ApprovalActivation = {
      id: `apac_${randomBytes(12).toString("base64url")}`,
      authReqId: current.id,
      principalId,
      transactionDigest,
      decision: parsed.data.decision,
      policyDigest,
      channelKind: "in_app",
      // The digest, never the challenge: a one-time value with no reason to
      // be readable at rest, and the digest is all the binding check needs.
      challengeDigest: challengeDigest(challenge),
      state: "pending",
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
      version: 1,
    };
    await ctx.repos.approvalActivations.create(activation);
    return c.json(
      BeginApprovalActivationResponseSchema.parse({
        activationId: activation.id,
        transactionDigest,
        policyDigest,
        expiresAt: activation.expiresAt.toISOString(),
        options,
      }),
      201,
    );
  },
);

/**
 * Verify the assertion, and do nothing else.
 *
 * Completing an activation moves it to `activated`; it does not settle
 * anything. The two steps are separate so that the thing which spends the
 * activation is a compare-and-set at settlement time — see `recordSettlement`
 * — rather than a side effect of a verification that might be retried.
 */
authorizationRequestRoutes.post(
  "/:id/activation/complete",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const id = c.req.param("id") ?? "";
    const parsed = CompleteApprovalActivationSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", detail: parsed.error.message },
        400,
      );
    }
    const body = parsed.data;
    if (
      [
        body.credentialId,
        body.clientDataJSON,
        body.authenticatorData,
        body.signature,
      ].some((value) => value.length > MAX_ASSERTION_FIELD_LENGTH)
    ) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const activation = await ctx.repos.approvalActivations.getById(
      body.activationId,
    );
    // Someone else's activation, or one for another request, is not found —
    // the same answer an id that never existed gets.
    if (
      !activation ||
      activation.principalId !== principalId ||
      activation.authReqId !== id
    ) {
      return c.json({ error: "activation_not_found" }, 404);
    }
    const now = ctx.clock();
    if (activation.expiresAt.getTime() <= now.getTime()) {
      return c.json({ error: "activation_expired" }, 410);
    }
    if (activation.state !== "pending") {
      return c.json({ error: "activation_not_pending" }, 409);
    }

    const challenge = challengeFromClientData(body.clientDataJSON);
    // The durable half of the binding: this assertion answered the one
    // challenge this activation was minted with. It is checked against the
    // stored digest rather than against the process's challenge map, because
    // the map belongs to one replica and the row belongs to the deployment.
    if (
      !challenge ||
      !digestsEqual(challengeDigest(challenge), activation.challengeDigest)
    ) {
      await auditActivationDenial(ctx, c, activation, "challenge_mismatch");
      return c.json({ error: "activation_challenge_mismatch" }, 401);
    }
    // The in-process half, when this replica still holds it: the challenge was
    // issued for *this* principal and *this* transaction. Absent, the check
    // above already established the binding; the load-bearing one-time
    // consumption is the durable `approvalActivations.consume` CAS at
    // settlement, never this map.
    const issued = ctx.passkeyChallenges.peek(challenge);
    if (
      issued &&
      (issued.purpose !== "transaction" ||
        issued.principalId !== principalId ||
        !issued.transactionDigest ||
        !digestsEqual(issued.transactionDigest, activation.transactionDigest))
    ) {
      await auditActivationDenial(ctx, c, activation, "challenge_unbound");
      return c.json({ error: "activation_challenge_mismatch" }, 401);
    }

    const verified = await ctx.passkeys.verify({
      credentialId: body.credentialId,
      clientDataJSON: Buffer.from(body.clientDataJSON, "base64"),
      authenticatorData: Buffer.from(body.authenticatorData, "base64"),
      signature: Buffer.from(body.signature, "base64"),
      // Only a challenge minted for an approval transaction may be spent
      // here, and a challenge minted here may not be spent as a plain second
      // factor at `/v1/mfa/passkey/assert`. The two ceremonies look identical
      // on the wire; the purpose is the only thing that separates them.
      expectedPurpose: "transaction",
    });
    // The credential has to belong to the approver. A valid assertion from
    // somebody else's authenticator is a valid assertion about somebody else.
    if (!verified.ok || verified.principalId !== principalId) {
      await auditActivationDenial(ctx, c, activation, "assertion_failed");
      return c.json({ error: "activation_verification_failed" }, 401);
    }

    const updated = await ctx.repos.approvalActivations.updateWithVersion(
      activation.id,
      activation.version,
      { state: "activated", activatedAt: now, method: "webauthn" },
    );
    return c.json({
      activationId: updated.id,
      state: updated.state,
      expiresAt: updated.expiresAt.toISOString(),
    });
  },
);

async function auditActivationDenial(
  ctx: AppContext,
  c: Context<{ Variables: Variables }>,
  activation: ApprovalActivation,
  reason: string,
): Promise<void> {
  // A refused ceremony is the event worth keeping: a trail of successes
  // cannot show five rejected assertions followed by one that worked.
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "authority.activation.denied",
    principalId: activation.principalId,
    actorType: "human",
    outcome: "denied",
    correlationId: c.get("correlationId"),
    metadata: {
      authReqId: activation.authReqId,
      activationId: activation.id,
      transactionDigest: activation.transactionDigest,
      reason,
    },
  });
}

/* ------------------------------------------------------------------ *
 * Settlement
 * ------------------------------------------------------------------ */

/**
 * Why the store would not spend an attempt.
 *
 * Read-only and after the fact: it does not decide anything, it only turns a
 * `null` into the reason a person can act on.
 */
async function comparisonRefusal(
  ctx: AppContext,
  authReqId: string,
  now: Date,
): Promise<
  | "comparison_not_found"
  | "comparison_expired"
  | "comparison_exhausted"
  | "comparison_already_satisfied"
> {
  const row = await ctx.repos.comparisonChallenges.getForRequest(authReqId);
  if (!row) return "comparison_not_found";
  if (row.satisfiedAt) return "comparison_already_satisfied";
  if (row.expiresAt.getTime() <= now.getTime()) return "comparison_expired";
  return "comparison_exhausted";
}

/** Allow or refuse. Only the approver may, and only with the digest they saw. */
function decideRoute(status: "approved" | "denied") {
  return async (c: Context<{ Variables: Variables }>) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const id = c.req.param("id") ?? "";
    const parsed = SettleAuthorizationRequestSchema.safeParse(
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
    // Compared against the value stored *with this row*. That is what keeps
    // rows written before the digest was canonicalized verifying: settlement
    // never re-derives a digest, it echoes back the one the approver was
    // shown, so a v1 row keeps checking out against its v1 value.
    if (row.requestDigest !== parsed.data.requestDigest) {
      // What was shown is not what is stored: refuse rather than consent to
      // something the approver did not read.
      return c.json({ error: "digest_mismatch" }, 409);
    }

    const now = ctx.clock();
    const requestPending =
      row.status === "pending" && now.getTime() < row.expiresAt.getTime();
    const { policy, policyDigest } = policyFor(ctx, row);
    const transactionDigest = approvalTransactionDigest({
      authReqId: row.id,
      requestDigest: row.requestDigest,
      approverPrincipalId: principalId,
      decision: status,
      policyDigest,
      channelKind: "in_app",
    });

    let activation: ApprovalActivation | undefined;
    let activationAuthentication: AuthenticationFacts | undefined;
    // Only fetched when the policy asks for one. An activation supplied
    // against a policy that does not require it is never spent, because
    // nothing would have checked it.
    if (policy.requireTransactionBoundActivation && parsed.data.activationId) {
      activation =
        (await ctx.repos.approvalActivations.getById(
          parsed.data.activationId,
        )) ?? undefined;
      if (activation?.state === "activated") {
        activationAuthentication = activationAuthenticationFacts(
          activation.activatedAt ?? now,
        );
      }
    }

    let comparisonSatisfied = false;
    if (policy.requireComparison && requestPending) {
      const presented = parsed.data.comparisonValue;
      if (!presented) {
        return c.json({ error: "comparison_required" }, 403);
      }
      // The budget is spent before the value is compared, and it is spent in
      // the store: a guess that costs nothing is not fenced by a maximum.
      const challenge = await ctx.repos.comparisonChallenges.consumeAttempt(
        id,
        now,
      );
      const outcome = challenge
        ? evaluateComparison({
            challenge,
            presentedDigest: comparisonValueDigest(
              id,
              presented,
              ctx.config.claimPepper,
            ),
            now,
          })
        : // The store refuses to spend an attempt on a challenge that is
          // exhausted, lapsed or already satisfied, and says only "no". A
          // person who has run out of guesses needs to be told that rather
          // than "wrong code, try again", so the row is re-read to name the
          // refusal — the budget has already been spent either way.
          { satisfied: false, refusal: await comparisonRefusal(ctx, id, now) };
      comparisonSatisfied = outcome.satisfied;
      if (!outcome.satisfied) {
        const refusal = outcome.refusal ?? "comparison_mismatch";
        // The value itself never reaches the audit trail — only that a
        // comparison was refused, and why.
        await appendAuditEvent(ctx.repos.auditEvents, {
          eventType: "authority.comparison.denied",
          principalId,
          actorType: "human",
          outcome: "denied",
          correlationId: c.get("correlationId"),
          metadata: { authReqId: id, reason: refusal },
        });
        return c.json(
          { error: refusal },
          refusal === "comparison_expired" ? 410 : 409,
        );
      }
    }

    if (requestPending) {
      const principal = await ctx.repos.principals.getById(principalId);
      if (!principal) return c.json({ error: "not_found" }, 404);
      const evidence = principalEvidence(
        principal,
        ctx.config.issuer,
        // Without an activation the honest facts are the surface's own
        // ceiling, not the ones a ceremony would have produced. Nothing gates
        // on this field, and that is exactly why it must not be inflated: a
        // reviewer reading the evidence later has no way to tell an assumed
        // fact from a proved one.
        activationAuthentication ?? channelAuthenticationCeiling("in_app", now),
      );
      const decision = evaluateApprovalCeremony({
        decision: status,
        path: "in_app",
        channelKind: "in_app",
        policy,
        approverPrincipalId: principalId,
        requestPrincipalId: row.principalId,
        // From the row, never from the activation: comparing an activation
        // against itself would let one minted for request A settle request B.
        authReqId: row.id,
        evidence,
        ...(activationAuthentication
          ? { activationAuthentication }
          : undefined),
        ...(activation ? { activation } : undefined),
        expectedTransactionDigest: transactionDigest,
        expectedPolicyDigest: policyDigest,
        requestPending,
        requestDigestMatches: true,
        comparisonSatisfied,
        now,
      });
      if (!decision.allowed) {
        const refusal = primaryRefusal(decision.refusals);
        await appendAuditEvent(ctx.repos.auditEvents, {
          eventType: "authority.invocation.denied",
          principalId,
          actorType: "human",
          outcome: "denied",
          correlationId: c.get("correlationId"),
          metadata: {
            authReqId: row.id,
            requestDigest: row.requestDigest,
            transactionDigest,
            policyDigest,
            refusals: decision.refusals.join(","),
          },
        });
        return c.json(
          {
            error: refusal,
            refusals: decision.refusals,
            required: decision.required,
            policyDigest,
          },
          refusalStatus(refusal),
        );
      }
      const outcome = await recordSettlement({
        ctx,
        row,
        decision: status,
        approverPrincipalId: principalId,
        path: "in_app",
        channelKind: "in_app",
        policy,
        policyDigest,
        transactionDigest,
        ...(activation ? { activation } : undefined),
        comparisonRequired: policy.requireComparison,
        comparisonSatisfied,
        required: decision.required,
        achieved: decision.achieved,
        evidenceIds: decision.assurance.evidence,
        ...(c.get("correlationId")
          ? { correlationId: c.get("correlationId") }
          : undefined),
        now,
        publish: true,
      });
      return settlementResponse(c, outcome, id);
    }

    // Not pending: no ceremony to run. Let the state machine produce the
    // refusal, so a settled or lapsed request answers exactly as it always
    // has (422 / 410) rather than as a policy failure.
    const outcome = await recordSettlement({
      ctx,
      row,
      decision: status,
      approverPrincipalId: principalId,
      path: "in_app",
      channelKind: "in_app",
      policy,
      policyDigest,
      transactionDigest,
      comparisonRequired: policy.requireComparison,
      comparisonSatisfied: false,
      required: [],
      achieved: [],
      evidenceIds: [],
      ...(c.get("correlationId")
        ? { correlationId: c.get("correlationId") }
        : undefined),
      now,
      publish: true,
    });
    return settlementResponse(c, outcome, id);
  };
}

function settlementResponse(
  c: Context<{ Variables: Variables }>,
  outcome: Awaited<ReturnType<typeof recordSettlement>>,
  id: string,
) {
  if (outcome.ok) {
    POLL_STATE.delete(id);
    return c.json(toResponse(outcome.request, c.get("ctx")));
  }
  if (outcome.reason === "domain") {
    return c.json(
      { error: outcome.error.code.toLowerCase() },
      domainErrorStatus(outcome.error.code),
    );
  }
  if (outcome.reason === "not_found") {
    return c.json({ error: "not_found" }, 404);
  }
  // Two approvers racing, one person double-clicking Approve, or an
  // activation someone else already spent: the state moved under us. That is
  // a conflict the caller can act on, not an internal error — and a 500 here
  // would look like the decision may have landed when it did not.
  return c.json(
    {
      error:
        outcome.reason === "activation_conflict"
          ? "activation_already_consumed"
          : "conflict",
    },
    409,
  );
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

/**
 * "I don't recognize this."
 *
 * Not a denial in the ordinary sense: a denial is a decision about a request
 * the person understood, and this is a report that the request should not
 * exist. It refuses the request — the safe direction, which grants nothing —
 * and raises a security event an operator can correlate.
 *
 * Deliberately quiet. It does not publish on the outbox and it does not
 * enqueue a notification: the person has just told us they are receiving
 * prompts they did not expect, and answering that with more traffic to the
 * same destinations is how a report becomes an amplifier.
 */
authorizationRequestRoutes.post(
  "/:id/report",
  requirePrincipal(),
  async (c) => {
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
    const row = await loadForApprover(ctx, id, principalId);
    if (!row) return c.json({ error: "not_found" }, 404);
    if (row.requestDigest !== parsed.data.requestDigest) {
      return c.json({ error: "digest_mismatch" }, 409);
    }
    const now = ctx.clock();
    const { policy, policyDigest } = policyFor(ctx, row);
    const transactionDigest = approvalTransactionDigest({
      authReqId: row.id,
      requestDigest: row.requestDigest,
      approverPrincipalId: principalId,
      decision: "denied",
      policyDigest,
      channelKind: "in_app",
    });
    // The security event is written first: it must survive even if the
    // request has already moved and the refusal below finds nothing to do.
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "security.approval.unrecognized",
      principalId,
      actorType: "human",
      outcome: "denied",
      correlationId: c.get("correlationId"),
      targetType: "authorization_request",
      targetId: row.id,
      metadata: {
        authReqId: row.id,
        requestDigest: row.requestDigest,
        requesterRef: row.requesterRef,
        reason: "not_recognized",
      },
    });
    const outcome = await recordSettlement({
      ctx,
      row,
      decision: "denied",
      approverPrincipalId: principalId,
      path: "in_app",
      channelKind: "in_app",
      policy,
      policyDigest,
      transactionDigest,
      comparisonRequired: policy.requireComparison,
      comparisonSatisfied: false,
      required: [],
      achieved: [],
      evidenceIds: [],
      ...(c.get("correlationId")
        ? { correlationId: c.get("correlationId") }
        : undefined),
      now,
      publish: false,
    });
    return settlementResponse(c, outcome, id);
  },
);

/**
 * The receipt.
 *
 * Readable by both parties: the approver needs to see what they were held to,
 * and the requester needs to see what carried the decision. It records what
 * was *required* as well as what was achieved, so a later policy change
 * cannot silently re-characterise a historical approval.
 */
authorizationRequestRoutes.get(
  "/:id/receipt",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const callerId = authenticatedPrincipalId(c.get("principalId"));
    const id = c.req.param("id") ?? "";
    const row = await loadForCaller(ctx, id, callerId);
    if (!row) return c.json({ error: "not_found" }, 404);
    const receipt = await ctx.repos.approvalReceipts.getForRequest(id);
    if (!receipt) return c.json({ error: "not_found" }, 404);
    return c.json(
      ApprovalReceiptResponseSchema.parse({
        authReqId: receipt.authReqId,
        decision: receipt.decision,
        decidedByKind: receipt.decidedByKind,
        path: receipt.path,
        channelKind: receipt.channelKind,
        requestDigest: receipt.requestDigest,
        transactionDigest: receipt.transactionDigest,
        policyDigest: receipt.policyDigest,
        requiredAssurance: receipt.requiredAssurance,
        achievedAssurance: receipt.achievedAssurance,
        comparisonRequired: receipt.comparisonRequired,
        comparisonSatisfied: receipt.comparisonSatisfied,
        decidedAt: receipt.decidedAt.toISOString(),
        receiptVersion: receipt.receiptVersion,
      }),
    );
  },
);
