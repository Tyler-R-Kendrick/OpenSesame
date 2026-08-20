/**
 * The authorization-request lifecycle (ADR 0046).
 *
 * A request waits for somebody to allow or refuse it. The states mirror the
 * `InvocationState::AwaitingApproval` edges the authority plane already
 * declares — `AwaitingApproval` may become `Authorized`, `Denied`,
 * `Cancelled`, or `Expired`, and nothing else — so an inbox decision and an
 * invocation transition cannot drift apart.
 *
 * Terminal states never reopen. A request that lapsed is not the same as one
 * that was refused, and a reviewer must be able to tell them apart.
 */

import { DomainError } from "../errors.js";
import type {
  ApprovalDecidedByKind,
  AuthorizationRequest,
  AuthorizationRequestStatus,
  PrincipalId,
} from "../types.js";

type AuthorizationRequestTransitions = {
  readonly [status in AuthorizationRequestStatus]: readonly AuthorizationRequestStatus[];
};

const TRANSITIONS: AuthorizationRequestTransitions = {
  pending: ["approved", "denied", "cancelled", "expired"],
  approved: [],
  denied: [],
  cancelled: [],
  expired: [],
};

export function canTransition(
  from: AuthorizationRequestStatus,
  to: AuthorizationRequestStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Refuse to act on a request whose clock has run out, whatever its stored
 * status says. Expiry is enforced on every transition rather than only by a
 * sweeper, so a late approval cannot slip through between ticks.
 */
export function assertNotExpired(
  request: AuthorizationRequest,
  now: Date,
): void {
  if (TRANSITIONS[request.status].length === 0) return;
  if (now.getTime() >= request.expiresAt.getTime()) {
    throw new DomainError("EXPIRED", "authorization request expired");
  }
}

export interface SettleInput {
  status: Extract<
    AuthorizationRequestStatus,
    "approved" | "denied" | "cancelled"
  >;
  decidedByPrincipalId: PrincipalId;
  decidedByKind: ApprovalDecidedByKind;
  now: Date;
}

/**
 * Record a decision.
 *
 * The digest is deliberately not re-derivable here: what was approved is what
 * the request already carries, and an executor compares its own canonical
 * digest against that value before running anything.
 */
export function settle(
  request: AuthorizationRequest,
  input: SettleInput,
): AuthorizationRequest {
  assertNotExpired(request, input.now);
  if (!canTransition(request.status, input.status)) {
    throw new DomainError(
      "INVALID_TRANSITION",
      `authorization request cannot go ${request.status} -> ${input.status}`,
    );
  }
  return {
    ...request,
    status: input.status,
    decidedAt: input.now,
    decidedByPrincipalId: input.decidedByPrincipalId,
    decidedByKind: input.decidedByKind,
    version: request.version + 1,
  };
}

/** Lazily mark a lapsed request expired when it is read. */
export function maybeExpire(
  request: AuthorizationRequest,
  now: Date,
): AuthorizationRequest {
  if (TRANSITIONS[request.status].length === 0) return request;
  if (now.getTime() < request.expiresAt.getTime()) return request;
  return { ...request, status: "expired", version: request.version + 1 };
}
