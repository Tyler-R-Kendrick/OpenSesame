import { appendAuditEvent } from "@opensesame/audit";
import { ConflictError } from "@opensesame/database";
import {
  DomainError,
  type Interaction,
  interactionMachine,
  withdrawRequest,
} from "@opensesame/os-domain";
import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { persistExpiry, toResponse } from "./authorization-requests.js";
import { requesterRef } from "./interaction-handles.js";
import { authenticatedPrincipalId } from "./organizations.js";

/**
 * The requester withdraws an authorization request (ADR 0046, ADR 0159).
 *
 * An inbox item lives until somebody answers it or it lapses, and a requester
 * that gives up — the agent it was raised for was cancelled, a host's own
 * timeout fired, the person was reached another way — had no way to say so:
 * the approver kept a question in their inbox that nobody was waiting on, and
 * could still approve it. Withdrawing is the requester's one move, and like
 * revoking an interaction it only ever removes authority.
 *
 * Requester only. The approver already has `/deny`, which records a decision;
 * a withdrawal records none (`withdrawRequest`), and letting the approver use
 * this route would let a refusal read as a retraction. Everyone else — the
 * approver included — gets the same 404 as an id that never existed, so the
 * route is not an oracle for who asked whom.
 *
 * Idempotent: withdrawing a request already withdrawn answers its current
 * state, so a client's best-effort cleanup can be retried without care. A
 * request that already has another ending (approved, refused, lapsed) keeps
 * it: 409 `request_not_pending` / 410 `expired_request`, never a rewrite.
 */
export const authorizationRequestCancelRoutes = new Hono<{
  Variables: Variables;
}>();

/**
 * Close the interaction fronting a withdrawn request, if one is live.
 *
 * Without this a request could be withdrawn while its interaction stayed
 * approvable, and the approval would then fail at settlement — a person
 * answering a question that no longer exists. Racing writers are normal (the
 * approver may be deciding right now), so a lost compare-and-set re-reads and
 * tries again rather than leaving the interaction live.
 */
async function withdrawFrontingInteraction(
  ctx: AppContext,
  requestId: string,
  now: Date,
  correlationId: string | undefined,
): Promise<Interaction | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const live = await ctx.repos.interactions.getBySubject(
      "authorization_request",
      requestId,
    );
    if (!live || interactionMachine.isTerminal(live.status)) return null;
    try {
      const revoked = interactionMachine.revoke(live, now);
      const saved = await ctx.repos.interactions.updateWithVersion(
        live.id,
        live.version,
        { status: revoked.status, revokedAt: now },
      );
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "interaction.revoked",
        actorType: "human",
        outcome: "succeeded",
        ...(correlationId ? { correlationId } : undefined),
        metadata: {
          interactionId: saved.id,
          interactionKind: saved.kind,
          subjectKind: saved.subject.kind,
          ...(saved.requestDigest
            ? { requestDigest: saved.requestDigest }
            : undefined),
        },
      });
      return saved;
    } catch (e) {
      if (e instanceof ConflictError) continue;
      if (e instanceof DomainError) return null;
      throw e;
    }
  }
  return null;
}

authorizationRequestCancelRoutes.post(
  "/:id/cancel",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const callerId = authenticatedPrincipalId(c.get("principalId"));
    const row = await ctx.repos.authorizationRequests.getById(
      c.req.param("id") ?? "",
    );
    if (
      !row ||
      row.requesterRef !== requesterRef(callerId, ctx.config.claimPepper)
    ) {
      return c.json({ error: "not_found" }, 404);
    }

    const now = ctx.clock();
    const current = await persistExpiry(ctx, row, now);
    if (current.status === "cancelled") {
      return c.json(toResponse(current, ctx));
    }
    if (current.status === "expired") {
      return c.json({ error: "expired_request", status: "expired" }, 410);
    }
    if (current.status !== "pending") {
      return c.json(
        { error: "request_not_pending", status: current.status },
        409,
      );
    }

    let saved: Awaited<ReturnType<typeof persistExpiry>>;
    try {
      const withdrawn = withdrawRequest(current, now);
      saved = await ctx.repos.authorizationRequests.updateWithVersion(
        current.id,
        current.version,
        { status: withdrawn.status, decidedAt: now },
      );
    } catch (e) {
      // Somebody settled it between the read and the write: the state moved
      // under us, and the caller can act on a conflict (a 500 would suggest
      // the withdrawal may have landed when it did not).
      if (e instanceof ConflictError) {
        return c.json({ error: "conflict" }, 409);
      }
      if (e instanceof DomainError) {
        return c.json({ error: "request_not_pending" }, 409);
      }
      throw e;
    }

    await withdrawFrontingInteraction(
      ctx,
      saved.id,
      now,
      c.get("correlationId"),
    );
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "authority.invocation.cancelled",
      principalId: callerId,
      actorType: "human",
      outcome: "succeeded",
      correlationId: c.get("correlationId"),
      // Digest-shaped keys only, as at creation.
      metadata: { authReqId: saved.id, requestDigest: saved.requestDigest },
    });
    return c.json(toResponse(saved, ctx));
  },
);
