/**
 * The approval transaction (ADR 0084).
 *
 * An approval is not a boolean arriving at a route. It is a claim that *this
 * person*, having *seen this exact request*, and having *proved themselves
 * just now to the standard this operation demands*, said yes. Each of those
 * clauses is a field here, and each is checked at settlement rather than
 * assumed from whatever authenticated the HTTP call.
 *
 * Pure: types and deterministic functions over `node:crypto` hashing. No
 * persistence, no HTTP, no provider vocabulary.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { canonicalize } from "./crypto/digest.js";
import type { JsonObject } from "./json.js";
import type {
  NotificationChannelKind,
  NotificationConfidentiality,
} from "./notifications.js";
import type { PrincipalId } from "./types.js";

/* ------------------------------------------------------------------ *
 * Canonical digests
 * ------------------------------------------------------------------ */

/**
 * Canonical digest of an RFC 9396 `authorization_details` array.
 *
 * v1 hashed `JSON.stringify(details)`, which is insertion-order dependent.
 * That was self-consistent — the value is computed once and stored — but it
 * quietly broke the property ADR 0046 actually promises: that an executor
 * can recompute the digest from the details it is about to act on and refuse
 * if it differs. Two encoders that agree on the JSON and disagree on key
 * order produce different digests, so the check either never runs or fails
 * for a request that is fine.
 *
 * v2 canonicalizes first (recursively sorted keys, arrays in order — RFC
 * 8785's semantics for the subset of JSON that survives an HTTP body), and
 * says so in the digest string. Old rows keep their v1 value and keep
 * verifying against it, because settlement compares a decision against the
 * digest *stored with the request*, never against a freshly derived one.
 */
export const AUTHORIZATION_DIGEST_VERSION = "v2";

export interface AuthorizationDigestInput {
  principalId: PrincipalId;
  requesterRef: string;
  authorizationDetails: JsonObject[];
  bindingMessage: string;
  connectionId?: string;
  delegationId?: string;
}

/**
 * Hash a fixed field order with explicit lengths.
 *
 * The length prefix is what stops two different requests from producing the
 * same bytes by moving text across a field boundary — a binding message
 * ending where a connection id begins.
 */
function lengthPrefixedDigest(domain: string, parts: string[]): string {
  const hash = createHash("sha256");
  hash.update(domain);
  hash.update("\0");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part, "utf8")));
    hash.update("\0");
    hash.update(part);
  }
  return hash.digest("hex");
}

export function authorizationRequestDigest(
  input: AuthorizationDigestInput,
): string {
  return `${AUTHORIZATION_DIGEST_VERSION}:${lengthPrefixedDigest(
    "opensesame:authorization-request:v2",
    [
      input.principalId,
      input.requesterRef,
      canonicalize(input.authorizationDetails),
      input.bindingMessage,
      input.connectionId ?? "",
      input.delegationId ?? "",
    ],
  )}`;
}

/**
 * The digest a WebAuthn activation is bound to.
 *
 * It commits to the decision as well as the request. Without the decision in
 * the transcript, an activation obtained for "deny" would be spendable as an
 * "approve" — the person proved they were present, and the server would
 * supply the verb.
 */
export interface ApprovalTransactionInput {
  authReqId: string;
  requestDigest: string;
  approverPrincipalId: PrincipalId;
  decision: "approved" | "denied";
  policyDigest: string;
  /** Where the approver came from, so a receipt can say. */
  channelKind: NotificationChannelKind;
}

export const APPROVAL_TRANSACTION_VERSION = "v1";

export function approvalTransactionDigest(
  input: ApprovalTransactionInput,
): string {
  return `${APPROVAL_TRANSACTION_VERSION}:${lengthPrefixedDigest(
    "opensesame:approval-transaction:v1",
    [
      input.authReqId,
      input.requestDigest,
      input.approverPrincipalId,
      input.decision,
      input.policyDigest,
      input.channelKind,
    ],
  )}`;
}

/**
 * Digest of the effective policy.
 *
 * Carried into the transaction digest so that tightening a policy between
 * the moment an activation is minted and the moment it is spent invalidates
 * the activation. Without it, a ceremony that satisfied yesterday's rules
 * could be presented against today's.
 */
export function approvalPolicyDigest(policy: JsonObject): string {
  return `v1:${createHash("sha256").update(canonicalize(policy)).digest("hex")}`;
}

/** Constant-time equality for digests and other public-but-comparable values. */
export function digestsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/* ------------------------------------------------------------------ *
 * Transaction-bound activation
 * ------------------------------------------------------------------ */

export type ApprovalActivationState = "pending" | "activated" | "consumed";

/**
 * A WebAuthn ceremony pinned to one approval transaction.
 *
 * The row exists before the assertion does: the challenge is minted here,
 * against this `transactionDigest`, and the assertion is checked against the
 * row rather than against "whatever challenge this process last handed out".
 * That is what makes it durable and multi-instance safe — the consumption is
 * a compare-and-set on a persisted row, not a delete from a process-local
 * map.
 *
 * `challengeDigest` rather than the challenge: the challenge is one-time
 * secret-ish material with no reason to be readable at rest.
 */
export interface ApprovalActivation {
  id: string;
  authReqId: string;
  principalId: PrincipalId;
  transactionDigest: string;
  decision: "approved" | "denied";
  policyDigest: string;
  channelKind: NotificationChannelKind;
  challengeDigest: string;
  state: ApprovalActivationState;
  createdAt: Date;
  activatedAt?: Date;
  consumedAt?: Date;
  expiresAt: Date;
  /** The trust session/activation this proved, once it has. */
  trustSessionId?: string;
  method?: string;
  version: number;
}

export type ActivationRefusal =
  | "activation_not_found"
  | "activation_wrong_request"
  | "activation_wrong_principal"
  | "activation_wrong_decision"
  | "activation_transaction_mismatch"
  | "activation_policy_changed"
  | "activation_not_activated"
  | "activation_already_consumed"
  | "activation_expired";

export interface ActivationCheckInput {
  activation?: ApprovalActivation;
  authReqId: string;
  principalId: PrincipalId;
  decision: "approved" | "denied";
  expectedTransactionDigest: string;
  expectedPolicyDigest: string;
  maximumApprovalAgeSeconds: number;
  now: Date;
}

/**
 * May this activation be spent on this settlement?
 *
 * Every clause answers one of the cross-transaction attacks: a valid
 * activation for request A presented against request B, one minted for
 * "deny" replayed as "approve", one belonging to another principal, one that
 * was already spent, one minted under a laxer policy. Collecting the
 * refusals rather than returning early keeps the reasons legible in an audit
 * record; `permitted` is true only when there are none.
 */
export interface ActivationDecision {
  permitted: boolean;
  refusals: ActivationRefusal[];
}

export function evaluateActivation(
  input: ActivationCheckInput,
): ActivationDecision {
  const refusals: ActivationRefusal[] = [];
  const a = input.activation;
  if (!a) return { permitted: false, refusals: ["activation_not_found"] };
  if (a.authReqId !== input.authReqId) {
    refusals.push("activation_wrong_request");
  }
  if (a.principalId !== input.principalId) {
    refusals.push("activation_wrong_principal");
  }
  if (a.decision !== input.decision) {
    refusals.push("activation_wrong_decision");
  }
  if (!digestsEqual(a.transactionDigest, input.expectedTransactionDigest)) {
    refusals.push("activation_transaction_mismatch");
  }
  if (!digestsEqual(a.policyDigest, input.expectedPolicyDigest)) {
    refusals.push("activation_policy_changed");
  }
  if (a.state === "consumed") refusals.push("activation_already_consumed");
  else if (a.state !== "activated") refusals.push("activation_not_activated");
  if (a.expiresAt.getTime() <= input.now.getTime()) {
    refusals.push("activation_expired");
  }
  // Freshness is checked against the moment the person actually proved
  // themselves, not the moment the row was created: a challenge that sat
  // unanswered for ten minutes and was then answered is fresh; one answered
  // promptly and presented ten minutes later is not.
  const provedAt = a.activatedAt;
  if (
    provedAt &&
    input.now.getTime() - provedAt.getTime() >
      input.maximumApprovalAgeSeconds * 1000
  ) {
    refusals.push("activation_expired");
  }
  return { permitted: refusals.length === 0, refusals };
}

/* ------------------------------------------------------------------ *
 * Comparison ceremony
 * ------------------------------------------------------------------ */

/**
 * Number matching, per ADR 0046's anti-fatigue requirement.
 *
 * The value is server-generated, which is the whole point: `bindingMessage`
 * is requester-supplied text and a requester who can choose what the
 * approver compares has not been asked to compare anything.
 *
 * Only the digest is stored, and only the digest is ever logged. The
 * plaintext exists in one response body, on the initiating surface, and
 * nowhere else — never in the external notification, whose job is to send
 * the person to the surface that has it.
 */
export interface ComparisonChallenge {
  id: string;
  authReqId: string;
  /** HMAC-shaped digest of the plaintext. The plaintext is never persisted. */
  valueDigest: string;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  expiresAt: Date;
  satisfiedAt?: Date;
  version: number;
}

/** Six decimal digits: 10^6, fenced by a persistent attempt budget. */
export const COMPARISON_DIGITS = 6;
export const COMPARISON_MAX_ATTEMPTS = 5;

export type ComparisonRefusal =
  | "comparison_not_found"
  | "comparison_expired"
  | "comparison_exhausted"
  | "comparison_mismatch"
  | "comparison_already_satisfied";

export interface ComparisonCheckInput {
  challenge?: ComparisonChallenge;
  presentedDigest: string;
  now: Date;
}

export interface ComparisonDecision {
  satisfied: boolean;
  refusal?: ComparisonRefusal;
}

export function evaluateComparison(
  input: ComparisonCheckInput,
): ComparisonDecision {
  const c = input.challenge;
  if (!c) return { satisfied: false, refusal: "comparison_not_found" };
  if (c.satisfiedAt) {
    return { satisfied: false, refusal: "comparison_already_satisfied" };
  }
  if (c.expiresAt.getTime() <= input.now.getTime()) {
    return { satisfied: false, refusal: "comparison_expired" };
  }
  // The budget is checked before the comparison, and it is stored rather than
  // counted in memory: a budget that a second process does not see is not a
  // budget, and re-issuing a code must not hand back a fresh set of guesses.
  if (c.attempts >= c.maxAttempts) {
    return { satisfied: false, refusal: "comparison_exhausted" };
  }
  if (!digestsEqual(c.valueDigest, input.presentedDigest)) {
    return { satisfied: false, refusal: "comparison_mismatch" };
  }
  return { satisfied: true };
}

/* ------------------------------------------------------------------ *
 * Receipts
 * ------------------------------------------------------------------ */

/**
 * How the decision reached us.
 *
 * `external_direct` and `external_rendezvous` are deliberately distinct: one
 * means a provider callback settled it, the other that a provider message
 * merely pointed a person at the in-app ceremony. A reviewer asking "could a
 * compromised Slack workspace have caused this?" needs to be able to tell,
 * years later, without re-deriving it from policy that has since changed.
 */
export type ApprovalPath =
  | "in_app"
  | "external_rendezvous"
  | "external_direct"
  | "agent";

/**
 * Why this request was allowed — the record that outlives the policy.
 *
 * `requiredAssurance` and `achievedAssurance` are both kept. Storing only
 * "allowed" would leave a future reviewer unable to distinguish a decision
 * that cleared a strict bar from one that cleared a lax one, and would let a
 * later policy change silently re-characterise historical approvals.
 */
export interface ApprovalReceipt {
  id: string;
  authReqId: string;
  principalId: PrincipalId;
  decision: "approved" | "denied";
  decidedByKind: "human" | "agent";
  path: ApprovalPath;
  channelKind: NotificationChannelKind;
  bindingId?: string;
  requestDigest: string;
  transactionDigest: string;
  policyDigest: string;
  /** Reason codes from the assurance evaluator, not a scalar. */
  requiredAssurance: string[];
  achievedAssurance: string[];
  evidenceIds: string[];
  trustSessionId?: string;
  activationId?: string;
  comparisonRequired: boolean;
  comparisonSatisfied: boolean;
  /** Digest of the provider callback that settled it, when one did. */
  callbackDigest?: string;
  decidedAt: Date;
  receiptVersion: number;
}

/* ------------------------------------------------------------------ *
 * Delivery
 * ------------------------------------------------------------------ */

export type NotificationDeliveryState =
  | "pending"
  | "delivered"
  | "failed"
  | "dead"
  | "skipped";

/**
 * One attempt to tell one person on one channel.
 *
 * A separate state machine from the authorization request on purpose, and
 * the separation is a security property rather than tidiness: nothing that
 * happens here may move the request. A dead-lettered delivery has not denied
 * anything; a delivered one has not approved anything.
 */
export interface NotificationDelivery {
  id: string;
  principalId: PrincipalId;
  kind: NotificationChannelKind;
  bindingId?: string;
  /** Set for the generic-webhook adapter, which routes by endpoint. */
  endpointId?: string;
  notificationClass: string;
  eventType: string;
  /** Correlates back to the outbox row that produced this. */
  outboxEventId: string;
  authReqId?: string;
  /** Rendered body, already reduced to the step's confidentiality. */
  payload: JsonObject;
  confidentiality: NotificationConfidentiality;
  state: NotificationDeliveryState;
  attempts: number;
  nextAttemptAt: Date;
  /** Classified error, never a provider response body. */
  lastError?: string;
  createdAt: Date;
  deliveredAt?: Date;
  /** Provider handle for a message we may later revise or withdraw. */
  providerMessageRef?: string;
}

/* ------------------------------------------------------------------ *
 * Callback replay ledger
 * ------------------------------------------------------------------ */

/**
 * A callback we have already processed.
 *
 * Keyed by the digest of the provider's own delivery identity — for Slack
 * the signature over the raw body, for Telegram the update id, for a push
 * receipt the subscription and message. Durable, because "have I seen this?"
 * answered from process memory is answered wrongly by the second instance,
 * and a replayed approval is the whole prize.
 */
export interface CallbackReplayRecord {
  /** `${providerId}:${digest}` — unique. */
  id: string;
  providerId: string;
  callbackDigest: string;
  seenAt: Date;
  expiresAt: Date;
  authReqId?: string;
}
