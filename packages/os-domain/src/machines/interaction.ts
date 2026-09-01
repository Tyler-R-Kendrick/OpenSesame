/**
 * The interaction lifecycle (ADR 0086).
 *
 * One machine for every surface. A Google Wallet pass, a scanned QR, a phone
 * notification and a CLI poll all drive the same transitions, so there is
 * exactly one place where "may this be approved now?" is answered and exactly
 * one definition of terminal.
 *
 * Terminal states never reopen. This is what makes a photographed QR useless
 * after the fact: the reference still resolves, and it resolves to `consumed`.
 */

import { DomainError } from "../errors.js";
import type {
  ApprovalProof,
  Interaction,
  InteractionKind,
  InteractionStatus,
} from "../interaction.js";
import type { PrincipalId } from "../types.js";

type InteractionTransitions = {
  readonly [status in InteractionStatus]: readonly InteractionStatus[];
};

/**
 * Legal edges.
 *
 * `approved -> revoked` is here even though an approval has already been
 * given: between approving and executing there is a window, and a user who
 * changes their mind inside it must be able to close it. Revocation only ever
 * removes authority, so admitting the edge cannot widen anything.
 *
 * Denial is reachable from every pre-decision state for the same reason —
 * refusing is always safe. It is the *route* that must prove the denier is
 * the approver; the machine's job is only to say the shape is legal.
 */
const TRANSITIONS: InteractionTransitions = {
  pending: ["presented", "awaiting_approval", "denied", "expired", "revoked"],
  presented: ["awaiting_approval", "denied", "expired", "revoked"],
  awaiting_approval: ["approved", "denied", "expired", "revoked"],
  approved: ["consumed", "expired", "revoked"],
  denied: [],
  consumed: [],
  expired: [],
  revoked: [],
};

/**
 * Kinds that authorize an *operation*, and so must never be approved without a
 * digest to bind the approval to.
 *
 * The distinction is the one ADR 0009 draws. Approving a device says a session
 * may exist; claiming says a principal owns a resource. Neither carries an
 * operation whose amount or target could be swapped afterwards, so neither
 * needs a digest. Allowing a call, delegating a grant, or moving money does
 * carry one, and for those the digest is the entire point.
 *
 * Storage cannot enforce this — `request_digest` is nullable because half the
 * kinds legitimately have none — so the machine does. Without it a
 * `transaction_authorization` whose digest was never set could be approved by
 * a proof bound to nothing, which is a payment approved with no statement of
 * what was being paid.
 */
const KINDS_REQUIRING_DIGEST: ReadonlySet<InteractionKind> = new Set([
  "authorization_request",
  "transaction_authorization",
  "grant_claim",
]);

export function canTransition(
  from: InteractionStatus,
  to: InteractionStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/** True once nothing further can happen to an interaction. */
export function isTerminal(status: InteractionStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/**
 * Refuse to act on an interaction whose clock has run out, whatever the stored
 * status says.
 *
 * Checked on every transition rather than only by a sweeper: between two ticks
 * of a background job there is a window in which a lapsed row still reads
 * `pending`, and an approval that lands in that window would otherwise be
 * honoured.
 */
/**
 * True when a deadline has passed — or cannot be read at all.
 *
 * The second half is the point. `NaN` loses every comparison, so an
 * unrepresentable date written as `expiresAt >= now` silently answers "not
 * expired" and the window never closes. Writing the check as an explicit
 * lapse test, with a non-finite value counted as lapsed, makes the failure
 * direction a decision rather than an accident of IEEE-754. An expiry nobody
 * can read is not a licence to keep going.
 */
function hasLapsed(expiresAt: Date, now: Date): boolean {
  const deadline = expiresAt.getTime();
  if (!Number.isFinite(deadline)) return true;
  return now.getTime() >= deadline;
}

export function assertLive(interaction: Interaction, now: Date): void {
  if (isTerminal(interaction.status)) {
    throw new DomainError(
      "INVALID_TRANSITION",
      `interaction is ${interaction.status}`,
    );
  }
  if (hasLapsed(interaction.expiresAt, now)) {
    throw new DomainError("EXPIRED", "interaction expired");
  }
}

/** Lazily project a lapsed interaction as expired when it is read. */
export function maybeExpire(interaction: Interaction, now: Date): Interaction {
  if (isTerminal(interaction.status)) return interaction;
  if (!hasLapsed(interaction.expiresAt, now)) return interaction;
  return {
    ...interaction,
    status: "expired",
    version: interaction.version + 1,
  };
}

function step(
  interaction: Interaction,
  to: InteractionStatus,
  now: Date,
  patch: Partial<Interaction> = {},
): Interaction {
  assertLive(interaction, now);
  if (!canTransition(interaction.status, to)) {
    throw new DomainError(
      "INVALID_TRANSITION",
      `interaction cannot go ${interaction.status} -> ${to}`,
    );
  }
  return {
    ...interaction,
    ...patch,
    status: to,
    version: interaction.version + 1,
  };
}

/**
 * Record that somebody resolved the reference.
 *
 * Idempotent, and idempotent on purpose: a wallet pass that is opened twice,
 * or a QR scanned by both the camera app and the browser, must not look like
 * two events. Presentation is a display fact, never an authorization fact.
 */
export function present(interaction: Interaction, now: Date): Interaction {
  if (interaction.status === "presented") return interaction;
  if (interaction.status === "awaiting_approval") return interaction;
  return step(interaction, "presented", now, { presentedAt: now });
}

/** The approver has been identified; the question is now in front of them. */
export function awaitApproval(
  interaction: Interaction,
  approverPrincipalId: PrincipalId,
  now: Date,
): Interaction {
  if (interaction.status === "awaiting_approval") {
    return { ...interaction, approverPrincipalId };
  }
  return step(interaction, "awaiting_approval", now, { approverPrincipalId });
}

export interface ApproveInput {
  approverPrincipalId: PrincipalId;
  proof: ApprovalProof;
  now: Date;
}

/**
 * Approve, binding the proof to the request.
 *
 * The digest check is the load-bearing line in this file. A valid WebAuthn
 * assertion or a valid verifiable presentation proves that *somebody approved
 * something*; only the digest proves they approved *this*. Refusing here is
 * what stops a proof minted for a $1 request from settling a $10,000 one, and
 * it is PSD2 dynamic linking (EU 2018/389 RTS Art. 5) applied to arbitrary
 * operations.
 */
export function approve(
  interaction: Interaction,
  input: ApproveInput,
): Interaction {
  if (interaction.requestDigest !== undefined) {
    if (input.proof.boundDigest !== interaction.requestDigest) {
      throw new DomainError(
        "INVARIANT_VIOLATION",
        "approval proof is bound to a different request",
      );
    }
  } else if (KINDS_REQUIRING_DIGEST.has(interaction.kind)) {
    // Refusing here rather than trusting the writer: this kind authorizes an
    // operation, so an approval that binds to nothing would be an approval of
    // whatever the executor later decided to run.
    throw new DomainError(
      "INVARIANT_VIOLATION",
      `a ${interaction.kind} cannot be approved without a request digest`,
    );
  } else if (input.proof.boundDigest.length > 0) {
    // A proof bound to a digest the interaction does not have cannot be
    // checked against anything, so it must not be accepted as if it had been.
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "interaction carries no digest to bind an approval to",
    );
  }
  return step(interaction, "approved", input.now, {
    approverPrincipalId: input.approverPrincipalId,
    approvalProof: input.proof,
    decidedAt: input.now,
  });
}

export function deny(
  interaction: Interaction,
  approverPrincipalId: PrincipalId,
  now: Date,
): Interaction {
  return step(interaction, "denied", now, {
    approverPrincipalId,
    decidedAt: now,
  });
}

/**
 * Spend the approval.
 *
 * Separate from `approve` because approval and execution are separate events
 * with a gap between them, and the gap is where replay lives. One approved
 * interaction yields exactly one consumption; the second caller to arrive
 * finds a terminal row and is refused. Storage must make this atomic — the
 * version check on the update is what actually serializes two racing
 * executors, not this function.
 */
export function consume(interaction: Interaction, now: Date): Interaction {
  if (interaction.status !== "approved") {
    throw new DomainError(
      "INVALID_TRANSITION",
      `interaction cannot be consumed from ${interaction.status}`,
    );
  }
  return step(interaction, "consumed", now, { consumedAt: now });
}

/** Withdraw an interaction. Always available before consumption. */
export function revoke(interaction: Interaction, now: Date): Interaction {
  if (isTerminal(interaction.status)) {
    throw new DomainError(
      "INVALID_TRANSITION",
      `interaction is already ${interaction.status}`,
    );
  }
  return {
    ...interaction,
    status: "revoked",
    revokedAt: now,
    version: interaction.version + 1,
  };
}
