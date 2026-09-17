/**
 * Which approval mechanisms can back which assurance (ADR 0086, ADR 0084).
 *
 * An `ApprovalProof` records a `mechanism` and an `assurance`, and the two are
 * not independent. Phishing resistance is a property of *how* the human was
 * asked, not a label the record may carry freely. A re-authenticated session
 * and a code read off one screen and typed into another are both phishable by
 * construction — an attacker who can stand between the human and the real site
 * can harvest and replay either — so neither may ever back `phishing_resistant`
 * assurance, whatever the principal record happens to say.
 *
 * A WebAuthn assertion and a holder-key-bound OpenID4VP presentation are the
 * two mechanisms whose success is scoped to the verifier's own origin: the
 * key signs over the relying party, so a proof gathered by a look-alike site
 * does not verify against the real one. Those are the only mechanisms that may
 * carry phishing-resistant assurance or satisfy a policy that demands it.
 *
 * This module is the authoritative table. `sealApprovalProof` in os-domain
 * builds the proof from server facts; this is what a route consults *before*
 * sealing, so an incoherent pairing is refused rather than written.
 */

import type {
  ApprovalMechanism,
  AssuranceLevel,
  InteractionKind,
} from "@opensesame/os-domain";

/**
 * The mechanisms whose success is bound to the verifier's origin, and so
 * survive a phishing intermediary.
 *
 * `session_reauth` (a re-authenticated session, including a TOTP step) and
 * `out_of_band` (a code delivered and typed) are deliberately absent: both are
 * shared-secret or bearer flows a relaying attacker can complete.
 */
const PHISHING_RESISTANT_MECHANISMS: ReadonlySet<ApprovalMechanism> = new Set([
  "webauthn",
  "openid4vp",
]);

/**
 * True when a mechanism's success is scoped to the verifier's origin.
 *
 * Total over the closed `ApprovalMechanism` union: a mechanism added later
 * defaults to *not* phishing-resistant, which is the safe direction — a new
 * mechanism claims the stronger property only by being added to the set on
 * purpose, never by omission.
 */
export function isPhishingResistantMechanism(
  mechanism: ApprovalMechanism,
): boolean {
  return PHISHING_RESISTANT_MECHANISMS.has(mechanism);
}

/**
 * What a decision maker asks of the mechanism behind an approval.
 *
 * Only phishing resistance is expressed here today, because it is the one
 * requirement a mechanism alone can satisfy or fail. Other assurance
 * dimensions — proofing, device binding — are properties of the principal and
 * the authenticator, checked against `AssuranceRequirement` elsewhere.
 */
export interface MechanismRequirement {
  requirePhishingResistance?: boolean;
}

export type MechanismDecisionEffect = "satisfied" | "refused";

export interface MechanismDecision {
  effect: MechanismDecisionEffect;
  /** Stable reason codes, never prose to branch on. */
  reasons: string[];
}

/**
 * Decide whether a mechanism satisfies a requirement.
 *
 * A requirement that asks nothing is satisfied by any mechanism; the only way
 * to be refused is to demand phishing resistance from a mechanism that has
 * none. Written as an explicit allow/deny rather than a boolean so a caller
 * records *why* an approval was refused.
 */
export function mechanismSatisfies(
  mechanism: ApprovalMechanism,
  requirement: MechanismRequirement,
): MechanismDecision {
  if (
    requirement.requirePhishingResistance === true &&
    !isPhishingResistantMechanism(mechanism)
  ) {
    return {
      effect: "refused",
      reasons: ["phishing_resistance_required", `mechanism_${mechanism}`],
    };
  }
  return { effect: "satisfied", reasons: ["mechanism_permitted"] };
}

export class IncoherentAssuranceError extends Error {
  readonly mechanism: ApprovalMechanism;
  readonly assurance: AssuranceLevel;

  constructor(mechanism: ApprovalMechanism, assurance: AssuranceLevel) {
    super(
      `mechanism ${mechanism} cannot back ${assurance} assurance: it is not phishing-resistant`,
    );
    this.name = "IncoherentAssuranceError";
    this.mechanism = mechanism;
    this.assurance = assurance;
  }
}

/**
 * Refuse an assurance a mechanism cannot honestly carry.
 *
 * The single coherence rule: `phishing_resistant` assurance requires a
 * phishing-resistant mechanism. A route reads the assurance from the
 * approver's principal record and the mechanism from what it verified; if the
 * principal is marked phishing-resistant but the approval was settled by a
 * session re-auth or an out-of-band code, the *approval* did not clear that
 * bar and the recorded proof must not claim it did.
 *
 * Other assurance levels pass unchallenged: a phishing-resistant mechanism may
 * of course back a weaker assurance, and a weaker assurance backed by a weaker
 * mechanism is coherent.
 */
export function assertAssuranceCoherent(
  mechanism: ApprovalMechanism,
  assurance: AssuranceLevel,
): void {
  if (
    assurance === "phishing_resistant" &&
    !isPhishingResistantMechanism(mechanism)
  ) {
    throw new IncoherentAssuranceError(mechanism, assurance);
  }
}

const PHISHING_RESISTANT_KINDS: ReadonlySet<InteractionKind> = new Set([
  "authorization_request",
  "transaction_authorization",
  "grant_claim",
]);

/** True when this interaction kind may only be approved by a phishing-resistant mechanism. */
export function interactionRequiresPhishingResistance(
  kind: InteractionKind,
): boolean {
  return PHISHING_RESISTANT_KINDS.has(kind);
}

export function mechanismPermittedForKind(
  mechanism: ApprovalMechanism,
  kind: InteractionKind,
): MechanismDecision {
  return mechanismSatisfies(mechanism, {
    requirePhishingResistance: interactionRequiresPhishingResistance(kind),
  });
}
