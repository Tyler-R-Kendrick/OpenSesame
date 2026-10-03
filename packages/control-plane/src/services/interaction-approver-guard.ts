/**
 * Who a requester may put an interaction in front of (ADR 0086, ADR 0150).
 *
 * An inbox handle is what authorizes the *asking*, and until this guard it was
 * the only thing checked. For an agent's authorization request that left two
 * ways to make a person's "yes" mean less than it appears to:
 *
 * - the requester could name **itself** — a bearer that belongs to the
 *   approver's own principal (an agent running as its owner) fronts a request
 *   and the same principal answers it, so no second party ever looked; and
 * - the requester could name **somebody other than the request's addressee**,
 *   raising an authorization request to A and fronting it with an interaction
 *   that asks B, whose approval then settles A's request.
 *
 * Both answer as every other refusal on the create route does — 404
 * `interaction_not_found`, one answer at one cost — so the guard is not an
 * oracle for which principals exist or who a request was addressed to.
 *
 * Only `authorization_request` is bound this way. The other kinds fronted here
 * — a device, a pairing, a claim, a transaction — are ceremonies one person
 * legitimately runs across two devices (`resolveEntitledSubject` requires the
 * caller to *own* them), so requester == approver is their ordinary case and
 * refusing it would break them. An authorization request is the opposite: a
 * party asking a person, which is exactly what "a second pair of eyes" means.
 */

import type { InteractionKind } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";

export interface ApproverAsk {
  readonly kind: InteractionKind;
  readonly subjectId: string;
  /** The authenticated principal raising the interaction. */
  readonly callerId: string;
  /** The principal the (already verified) inbox handle resolved to. */
  readonly approverId: string;
}

/** True when `approverId` may be asked by `callerId` about this subject. */
export async function approverMayBeAsked(
  ctx: AppContext,
  ask: ApproverAsk,
): Promise<boolean> {
  if (ask.kind !== "authorization_request") return true;
  if (ask.approverId === ask.callerId) return false;
  const request = await ctx.repos.authorizationRequests.getById(ask.subjectId);
  return request !== null && request.principalId === ask.approverId;
}
