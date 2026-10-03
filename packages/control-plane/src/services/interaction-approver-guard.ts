/**
 * Who a requester may put an interaction in front of (ADR 0086, ADR 0159).
 *
 * An inbox handle is what authorizes the *asking*, and until this guard it was
 * the only thing checked. For an agent's authorization request that left
 * three ways to make a person's "yes" mean less than it appears to:
 *
 * - the requester could name **itself** — a bearer that belongs to the
 *   approver's own principal (an agent running as its owner) fronts a request
 *   and the same principal answers it, so no second party ever looked; and
 * - the requester could name **somebody other than the request's addressee**,
 *   raising an authorization request to A and fronting it with an interaction
 *   that asks B, whose approval then settles A's request; and
 * - the requester could front a request with **details of its own**: the
 *   digest the approver's activation is bound to is computed over what the
 *   create call carried, so details that are not the request's (see
 *   `detailsMatchRequest`) would let A approve Y while the agent holds
 *   approval of X.
 *
 * All answer as every other refusal on the create route does — 404
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

import {
  type AuthorizationRequest,
  DomainError,
  type Interaction,
  type InteractionKind,
  type JsonObject,
  canonicalize,
} from "@opensesame/os-domain";
import type { AppContext } from "../context.js";

export interface ApproverAsk {
  readonly kind: InteractionKind;
  readonly subjectId: string;
  /** The authenticated principal raising the interaction. */
  readonly callerId: string;
  /** The principal the (already verified) inbox handle resolved to. */
  readonly approverId: string;
  /** The details the interaction would show the approver, as submitted. */
  readonly authorizationDetails: readonly JsonObject[];
}

/** True when `approverId` may be asked by `callerId` about this subject. */
export async function approverMayBeAsked(
  ctx: AppContext,
  ask: ApproverAsk,
): Promise<boolean> {
  if (ask.kind !== "authorization_request") return true;
  if (ask.approverId === ask.callerId) return false;
  const request = await ctx.repos.authorizationRequests.getById(ask.subjectId);
  return (
    request !== null &&
    request.principalId === ask.approverId &&
    detailsMatchRequest(
      ask.kind,
      ask.authorizationDetails,
      request.authorizationDetails,
    )
  );
}

/**
 * True when the details an interaction would ask a person to approve are the
 * details the authorization request it fronts actually carries.
 *
 * The interaction's `requestDigest` is computed over whatever details the
 * requester put on the create call, and the approver's WebAuthn activation is
 * bound to that digest. Without this comparison a requester could raise a
 * request for X and front it with an interaction showing a benign Y: the
 * approver would approve Y and the agent would hold approval of X. Compared by
 * canonical JSON (keys sorted, array order kept), so a client that re-orders
 * object members still matches while a changed, added or dropped detail does
 * not. The binding message is derived from the details server-side, so equal
 * details leave the approver no different sentence to be shown.
 *
 * Only `authorization_request` is bound; other kinds own their details.
 */
export function detailsMatchRequest(
  kind: InteractionKind,
  interactionDetails: readonly JsonObject[] | undefined,
  requestDetails: readonly JsonObject[],
): boolean {
  if (kind !== "authorization_request") return true;
  return (
    canonicalize([...(interactionDetails ?? [])]) ===
    canonicalize([...requestDetails])
  );
}

/**
 * Defense in depth at settlement: the approval was bound to the interaction's
 * details, so it may only settle a request that carries exactly those. The
 * create route refuses a mismatch first; this catches a row written any other
 * way. Throws the `DomainError` a consume already answers as a refusal.
 */
export function assertDetailsMatchRequest(
  interaction: Interaction,
  request: AuthorizationRequest,
): void {
  if (
    detailsMatchRequest(
      interaction.kind,
      interaction.authorizationDetails,
      request.authorizationDetails,
    )
  ) {
    return;
  }
  throw new DomainError(
    "INVARIANT_VIOLATION",
    "interaction details differ from the request",
  );
}
