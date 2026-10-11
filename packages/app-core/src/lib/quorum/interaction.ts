/**
 * A quorum request carried as an Interaction (ADR 0187 follow-up 5, ADR 0086).
 *
 * The Interaction layer is the one envelope for "a thing somebody must answer
 * on another screen". This fronts a quorum request with it and holds to
 * ADR 0086's rule that **a reference authorizes nothing**: the Interaction
 * names a request and mirrors where the quorum ledger says it is; it never
 * decides. Only a ledger verdict that a quorum approved, checked again here
 * against the circle's policy and the delay, moves it to `approved`.
 *
 * Three digests, kept apart on purpose:
 *
 * - `D_q`, the quorum request digest (`request.ts`). Every guardian's WebAuthn
 *   challenge derives from it, so it is what their keys actually signed.
 * - `D_i`, `Interaction.requestDigest`, framed as `canonicalRequestDigest` in
 *   `packages/os-domain/src/crypto/request-digest.ts` frames it: the same
 *   purpose string and length-prefixed fields, pinned by
 *   `spec/conformance/request-digest-vectors.json`. It is not `D_q`: it hashes
 *   the envelope, whose one authorization detail carries `D_q` as
 *   `quorumRequestDigest`, so `D_i` commits to `D_q`.
 * - `proof.boundDigest` is `D_i`, which `interactionMachine.approve` compares
 *   with `Interaction.requestDigest` for every kind. The chain an executor
 *   checks is key -> `D_q` (the ledger verified the challenge) -> `D_i`
 *   (recomputed from the envelope's own fields, and from the request) ->
 *   `boundDigest`. The proof does not say the keys signed `D_i`; it says the
 *   interaction that commits to what they signed was approved by a quorum.
 *
 * Not done: `D_i` is computed here with local handles for approver and
 * requester, so an Identity API, which mints its own handles, expiry and
 * digest, would assign another. Carrying a request through `POST
 * /v1/interactions` also needs a server subject adapter, and the route's
 * one-hour ttl ceiling is shorter than a request may live. Neither exists.
 *
 * No share, mnemonic, wrapped key or recipient secret is ever in the envelope.
 * A `recover-collection` request states its release rule instead: guardians
 * release separately, each from their own device, after `releaseNotBefore`.
 */

import { sha256 } from "@noble/hashes/sha2";
import {
  type ApprovalProof,
  type BoundaryValue,
  type Interaction,
  type InteractionStatus,
  interactionMachine,
  sealApprovalProof,
} from "@opensesame/os-domain";
import { toHex, utf8Bytes } from "./bytes.js";
import {
  type Bound,
  bind,
  refuse,
  requestToInteraction,
} from "./interaction-envelope.js";
import type { LedgerVerdict } from "./ledger-types.js";
import { satisfies } from "./policy.js";
import { ApprovalSchema, type SignedPolicy } from "./types.js";

export {
  QUORUM_DETAIL_TYPE,
  QuorumInteractionError,
  type QuorumDetail,
  quorumDigestOf,
  requestToInteraction,
} from "./interaction-envelope.js";

/** An interaction, and the request and policy it claims to front. */
type Subject = Readonly<{
  interaction: Interaction;
  request: BoundaryValue;
  signedPolicy: SignedPolicy;
}>;

/**
 * The interaction is exactly what this request makes, and the verdict speaks
 * of it. `D_i` recomputes from the envelope's own fields and equals the `D_i`
 * derived from the request, so every mirrored field, the sentence included, is
 * the request's own; the verdict names the same `D_q`, circle, operation and
 * window.
 */
function bindTo(input: Subject, verdict: LedgerVerdict): Bound {
  const { interaction } = input;
  const bound = bind(interaction);
  const expected = requestToInteraction({
    signedPolicy: input.signedPolicy,
    request: input.request,
    id: interaction.id,
  });
  if (expected.requestDigest !== bound.digest) {
    refuse("request", "this interaction does not front that request");
  }
  if (
    verdict.requestDigest !== bound.quorum ||
    verdict.circleId !== bound.detail.circleId ||
    verdict.operation !== bound.detail.actions[0] ||
    new Date(verdict.validUntil).getTime() !== interaction.expiresAt.getTime()
  ) {
    refuse("verdict", "the ledger's verdict is for another request");
  }
  return bound;
}

/** Every field is this adapter's own finding; none is read from a caller's proof. */
function facts(
  bound: Bound,
  verifiedAt: Date,
  credentialRef?: string,
): ApprovalProof {
  return {
    mechanism: "webauthn",
    boundDigest: bound.digest,
    assurance: "phishing_resistant",
    verifiedAt,
    ...(credentialRef ? { credentialRef } : undefined),
  };
}

/**
 * One guardian's accepted approval, as a record bound to the interaction.
 *
 * It is an `ApprovalProof`, not a `SealedApprovalProof`: one guardian's
 * approval is not the quorum's, and `interactionMachine.approve` does not take
 * it. Only `interactionSettlement` seals a proof, once the quorum is met.
 * `boundDigest` is `D_i`; the guardian's key signed `D_q` (see the header).
 */
export function approvalToProof(
  input: Subject &
    Readonly<{
      approval: BoundaryValue;
      verdict: LedgerVerdict;
      verifiedAt: Date;
    }>,
): ApprovalProof {
  const bound = bindTo(input, input.verdict);
  const parsed = ApprovalSchema.safeParse(input.approval);
  if (!parsed.success) refuse("approval", "this is not a quorum approval");
  const approval = parsed.data;
  if (approval.requestDigest !== bound.quorum) {
    refuse("digest", "this approval is for another request");
  }
  if (!input.verdict.approvedBy.includes(approval.guardianId)) {
    refuse(
      "not_accepted",
      "the ledger did not accept this guardian's approval",
    );
  }
  const credential = toHex(
    sha256(utf8Bytes(approval.credentialId)).slice(0, 8),
  );
  return facts(bound, input.verifiedAt, `${approval.guardianId}/${credential}`);
}

const STAGE = {
  pending: 0,
  awaiting_approval: 1,
  approved: 2,
  consumed: 3,
} as const;

type Stage = keyof typeof STAGE;
type Target = Stage | "revoked" | "expired" | "closed";

function targetOf(verdict: LedgerVerdict): Target {
  switch (verdict.state) {
    case "cancelled":
      return "revoked";
    case "expired":
      return "expired";
    case "approval_closed":
      return "closed";
    case "collecting":
      return verdict.approvedBy.length > 0 ? "awaiting_approval" : "pending";
    case "waiting":
      return "awaiting_approval";
    case "releasable":
    case "authorized":
    case "complete":
      return "approved";
    case "executed":
      return "consumed";
  }
}

function stageOf(status: InteractionStatus): number {
  if (status === "approved") return STAGE.approved;
  return status === "awaiting_approval" ? STAGE.awaiting_approval : 0;
}

/** The machine projects expiry from the clock; this edge is the ledger closing the window. */
function close(interaction: Interaction): Interaction {
  if (!interactionMachine.canTransition(interaction.status, "expired")) {
    refuse("regress", "this interaction cannot lapse");
  }
  return {
    ...interaction,
    status: "expired",
    version: interaction.version + 1,
  };
}

type Settling = Subject & Readonly<{ verdict: LedgerVerdict; now: Date }>;

/** A quorum counts only if who the ledger names satisfy the policy, and the delay has passed. */
function requireCounting(bound: Bound, input: Settling): void {
  const approved = new Set(input.verdict.approvedBy);
  if (!satisfies(input.signedPolicy.policy, approved)) {
    refuse("quorum", "the guardians named do not satisfy the circle's policy");
  }
  if (input.now.getTime() < new Date(bound.detail.releaseNotBefore).getTime()) {
    refuse("too_early", "the release delay has not passed");
  }
}

function advance(bound: Bound, input: Settling, target: Stage): Interaction {
  const { interaction, now } = input;
  const from = stageOf(interaction.status);
  const to = STAGE[target];
  if (to < from) {
    refuse("regress", "the ledger says less than the interaction holds");
  }
  if (to === from) return interaction;
  let next = interaction;
  if (from < STAGE.awaiting_approval) {
    next = interactionMachine.awaitApproval(next, bound.circle, now);
  }
  if (to >= STAGE.approved) requireCounting(bound, input);
  if (from < STAGE.approved && to >= STAGE.approved) {
    next = interactionMachine.approve(next, {
      approverPrincipalId: bound.circle,
      now,
      proof: sealApprovalProof(facts(bound, now)),
    });
  }
  return to === STAGE.consumed ? interactionMachine.consume(next, now) : next;
}

/**
 * Where the ledger says the request is, as the Interaction's next state.
 *
 * Only forward and only along the machine's own edges: `approved` needs a
 * verdict of `releasable`, `authorized` or `complete` for this very request,
 * guardians the policy is satisfied by, and the delay passed on `now`. A
 * quorum that has met but is `waiting` stays `awaiting_approval`. A lapsed
 * interaction is `expired` whatever a stale verdict says, a cancellation is
 * `revoked`, an executed action is `consumed`, and a terminal interaction
 * never reopens. `verdict` must come from `ledger.verdict()`; it is plain data
 * and this re-checks what it can (that the interaction fronts this request,
 * the circle, operation and window, the quorum against the policy, the delay)
 * but cannot know the ledger was honest.
 */
export function interactionSettlement(input: Settling): Interaction {
  const { interaction, verdict, now } = input;
  const bound = bindTo(input, verdict);
  if (interactionMachine.isTerminal(interaction.status)) return interaction;
  const target = targetOf(verdict);
  if (target === "revoked") return interactionMachine.revoke(interaction, now);
  const lapsed = interactionMachine.maybeExpire(interaction, now);
  if (lapsed.status === "expired") return lapsed;
  if (target === "expired") return close(interaction);
  if (target === "closed") {
    if (stageOf(interaction.status) >= STAGE.approved) {
      refuse("regress", "an approved interaction cannot lose its quorum");
    }
    return close(interaction);
  }
  return advance(bound, input, target);
}
