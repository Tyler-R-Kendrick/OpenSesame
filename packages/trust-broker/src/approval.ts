/**
 * One evaluator for "may this approval stand?" (ADR 0084).
 *
 * The authorization inbox, the provider callbacks and the in-app ceremony all
 * come through here. That is the design: a second place that decides whether
 * a decision is sufficient is a second place to get it wrong, and the one
 * that is wrong is the one an attacker will find.
 *
 * It composes, in order:
 *
 *   1. `evaluateDirectSettlement` — may this *channel* carry a decision at
 *      all, given policy, the binding, and the callback's provenance?
 *   2. `evaluateAssurance` — did the *person* meet the bar this operation
 *      sets, on the evidence actually held?
 *   3. `evaluateActivation` — was that proof bound to *this* transaction, and
 *      is it still unspent?
 *
 * All three must pass. None of them can stand in for another, and each is
 * fail-closed: absent evidence is not neutral, it is a refusal.
 */

import {
  type ActivationRefusal,
  type ApprovalActivation,
  type ApprovalPath,
  type ApprovalPolicy,
  type AssuranceVector,
  type CallbackFreshnessSource,
  type DirectSettlementRefusal,
  type ExternalChannelBinding,
  type IdentityEvidence,
  type NotificationChannelKind,
  type PrincipalId,
  type TrustSession,
  channelAuthenticationCeiling,
  evaluateActivation,
  evaluateDirectSettlement,
  normalizeApprovalPolicy,
} from "@opensesame/os-domain";
import { type AssuranceDecision, evaluateAssurance } from "./index.js";

export type ApprovalRefusal =
  | DirectSettlementRefusal
  | ActivationRefusal
  | "assurance_insufficient"
  | "channel_cannot_meet_assurance"
  | "approver_mismatch";

export interface ApprovalCeremonyInput {
  decision: "approved" | "denied";
  path: ApprovalPath;
  channelKind: NotificationChannelKind;
  policy: ApprovalPolicy;
  approverPrincipalId: PrincipalId;
  /** The principal the request is addressed to. */
  requestPrincipalId: PrincipalId;
  /**
   * The request being settled.
   *
   * Supplied by the caller from the row it loaded, never read back out of the
   * activation. Taking it from the activation would compare the activation
   * against itself, and an activation minted for one request would settle any
   * other — which is exactly the cross-transaction replay this field exists
   * to refuse.
   */
  authReqId: string;
  evidence: IdentityEvidence[];
  trustSession?: TrustSession;
  /**
   * Facts from an in-app WebAuthn activation. Supplied only by the ceremony
   * that actually ran one — never derived from a provider callback.
   */
  activationAuthentication?: AssuranceVector["authentication"];
  activation?: ApprovalActivation;
  expectedTransactionDigest: string;
  expectedPolicyDigest: string;
  binding?: ExternalChannelBinding;
  claimedIdentity?: {
    providerId: string;
    providerTenantId: string;
    providerSubjectId: string;
  };
  callbackAuthenticated?: boolean;
  callbackFresh?: boolean;
  /**
   * How freshness was established. Absent means "not established", which is a
   * refusal — the default has to be the safe one, because a caller that
   * forgets this field is a caller that did not check.
   */
  freshnessSource?: CallbackFreshnessSource;
  callbackUnseen?: boolean;
  requestPending: boolean;
  requestDigestMatches: boolean;
  comparisonSatisfied: boolean;
  now: Date;
}

export interface ApprovalCeremonyDecision {
  allowed: boolean;
  refusals: ApprovalRefusal[];
  assurance: AssuranceDecision;
  /** Reason codes required, for the receipt. */
  required: string[];
  /** Reason codes actually met, for the receipt. */
  achieved: string[];
}

/**
 * The authentication facts the ceremony may claim.
 *
 * An in-app activation supplies its own, from a verified WebAuthn assertion.
 * Anything else gets the channel's *ceiling* — the strongest set the adapter
 * could ever demonstrate — and nothing a provider asserted about itself. A
 * callback saying `"phishing_resistant": true` is a string in a JSON body;
 * this is why it can never become a fact.
 */
function ceremonyAuthentication(
  input: ApprovalCeremonyInput,
): AssuranceVector["authentication"] {
  if (input.activationAuthentication) return input.activationAuthentication;
  return channelAuthenticationCeiling(input.channelKind, input.now);
}

export function evaluateApprovalCeremony(
  input: ApprovalCeremonyInput,
): ApprovalCeremonyDecision {
  const policy = normalizeApprovalPolicy(input.policy);
  const refusals: ApprovalRefusal[] = [];

  // The approver is the person the request is addressed to. Checked here as
  // well as at the route, because a provider callback reaches settlement by a
  // different path than an authenticated session does and must not skip it.
  if (input.approverPrincipalId !== input.requestPrincipalId) {
    refusals.push("approver_mismatch");
  }

  if (input.path === "external_direct") {
    const direct = evaluateDirectSettlement({
      decision: input.decision,
      kind: input.channelKind,
      policy,
      ...(input.binding ? { binding: input.binding } : undefined),
      ...(input.claimedIdentity
        ? { claimedIdentity: input.claimedIdentity }
        : undefined),
      callbackAuthenticated: input.callbackAuthenticated === true,
      callbackFresh: input.callbackFresh === true,
      freshnessSource: input.freshnessSource ?? "none",
      callbackUnseen: input.callbackUnseen === true,
      requestPending: input.requestPending,
      requestDigestMatches: input.requestDigestMatches,
      comparisonSatisfied: input.comparisonSatisfied,
      now: input.now,
    });
    refusals.push(...direct.refusals);
  } else {
    if (!input.requestPending) refusals.push("request_not_pending");
    if (!input.requestDigestMatches) refusals.push("request_digest_changed");
    if (policy.requireComparison && !input.comparisonSatisfied) {
      refusals.push("comparison_required");
    }
  }

  const authentication = ceremonyAuthentication(input);
  const assurance = evaluateAssurance({
    evidence: input.evidence,
    authentication,
    ...(input.trustSession ? { trustSession: input.trustSession } : undefined),
    requirement: policy.requiredAssurance,
    now: input.now,
  });
  if (!assurance.allowed) {
    refusals.push("assurance_insufficient");
    // Say the useful thing when the reason is structural rather than
    // circumstantial: this channel could not have met the bar however the
    // person behaved, so the honest answer is "come to the app", not "try
    // again".
    if (
      !input.activationAuthentication &&
      policy.requiredAssurance.requirePhishingResistance === true
    ) {
      refusals.push("channel_cannot_meet_assurance");
    }
  }

  if (policy.requireTransactionBoundActivation) {
    const act = evaluateActivation({
      ...(input.activation ? { activation: input.activation } : undefined),
      authReqId: input.authReqId,
      principalId: input.approverPrincipalId,
      decision: input.decision,
      expectedTransactionDigest: input.expectedTransactionDigest,
      expectedPolicyDigest: input.expectedPolicyDigest,
      maximumApprovalAgeSeconds: policy.maximumApprovalAgeSeconds,
      now: input.now,
    });
    refusals.push(...act.refusals);
  }

  const required = requiredReasonCodes(policy);
  return {
    allowed: refusals.length === 0,
    refusals,
    assurance,
    required,
    achieved: assurance.satisfied,
  };
}

/** The bar, as reason codes, so a receipt records what was demanded. */
export function requiredReasonCodes(policy: ApprovalPolicy): string[] {
  const r = policy.requiredAssurance;
  const codes: string[] = [`subject_kind:${r.subjectKind}`];
  if (r.requireUserVerification) codes.push("user_verification");
  if (r.requirePhishingResistance) codes.push("phishing_resistance");
  if (r.requireVerifierNameBinding) codes.push("verifier_name_binding");
  if (r.minimumIdentityProofing?.length) codes.push("identity_proofing");
  if (r.minimumDeviceBinding?.length) codes.push("device_binding");
  if (r.minimumKeyProtection?.length) codes.push("key_protection");
  if (r.maximumAuthenticationAgeSeconds !== undefined) {
    codes.push("authentication_freshness");
  }
  if (r.acceptableAcrValues?.length) codes.push("acr");
  if (policy.requireTransactionBoundActivation) {
    codes.push("transaction_bound_activation");
  }
  if (policy.requireComparison) codes.push("comparison");
  return codes;
}
