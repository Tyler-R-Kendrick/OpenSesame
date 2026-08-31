/**
 * The canonical cross-device interaction (ADR 0086).
 *
 * Every human-facing handoff OpenSesame runs — approve this device, claim this
 * resource, allow this call, authorize this payment — is the same shape: a
 * thing somebody must look at on another screen and answer for. Before this
 * type existed each surface invented its own: the CLI built one link, the
 * mobile MFA app parsed another, Pages rendered a third, and a wallet pass
 * would have been a fourth. Four link formats means four places to get expiry,
 * replay, and enumeration wrong.
 *
 * So there is one envelope. An `Interaction` does not replace the ceremony it
 * fronts — the device-authorization session, the authorization request, the
 * claim session all keep their own records and their own state machines. It
 * *addresses* one, with an opaque reference that is safe to print on a screen,
 * photograph, or put in a Google Wallet pass, because possessing it authorizes
 * nothing at all.
 *
 * That last property is the whole design. Scanning is not approving. The
 * reference says which question is being asked; answering it still costs an
 * authenticated actor and a cryptographic proof bound to the exact request.
 */

import type { JsonObject } from "./json.js";
import type { AssuranceRequirement } from "./trust.js";
import type { AssuranceLevel, PrincipalId } from "./types.js";

/** Opaque interaction id. Random, never derived from what it fronts. */
export type InteractionId = string;

/**
 * The ceremony an interaction stands in front of.
 *
 * Kinds are not interchangeable, and in particular `device_authorization` is
 * not `claim`: approving a device says a session may exist, and claiming says
 * a principal owns a resource. ADR 0009 separates them deliberately, and a
 * single envelope over both must not become the place they get confused. A
 * wallet scan that lands on a device-authorization interaction can only ever
 * settle that device authorization.
 */
export type InteractionKind =
  | "device_authorization"
  | "pairing"
  | "claim"
  | "grant_claim"
  | "authorization_request"
  | "transaction_authorization";

/**
 * Where an interaction is.
 *
 * `presented` records that the reference was resolved by somebody — a QR was
 * scanned, a pass was opened — and is deliberately *not* an approval step. It
 * exists so the requesting side can show "opened on another device" without
 * that display ever being mistaken for consent.
 */
export type InteractionStatus =
  | "pending"
  | "presented"
  | "awaiting_approval"
  | "approved"
  | "denied"
  | "consumed"
  | "expired"
  | "revoked";

/** How an approval was proven. Recorded, never inferred from the session. */
export type ApprovalMechanism =
  | "webauthn"
  | "openid4vp"
  | "session_reauth"
  | "out_of_band";

/**
 * The record a subject is bound to.
 *
 * `subjectId` is the underlying ceremony's own primary key. It never travels
 * to a client: a caller resolving an interaction learns the interaction's
 * reference and nothing about the row behind it, so an interaction reference
 * cannot be turned into a device-session or authorization-request id.
 */
export interface InteractionSubject {
  kind: InteractionKind;
  subjectId: string;
}

/**
 * A verified approval, reduced to what is safe to keep.
 *
 * No assertion bytes, no verifiable presentation, no JOSE — those are proof
 * *inputs*, verified once at the protocol edge and dropped. What survives is
 * the fact of verification and the digest it was bound to, because that is
 * the only part an executor needs and the only part that is safe in an audit
 * record.
 */
export interface ApprovalProof {
  mechanism: ApprovalMechanism;
  /**
   * The request digest this proof was computed over. An executor compares its
   * own canonical digest against this value; a mismatch is a refusal, not a
   * warning. Without this field every approval in the system is decorative.
   */
  boundDigest: string;
  /** Non-secret handle for the key or credential that signed. */
  credentialRef?: string;
  assurance: AssuranceLevel;
  verifiedAt: Date;
}

/**
 * The canonical interaction.
 *
 * Times are server-derived. A client may not assert when something expired or
 * when it was approved, because a client that can move those values can hold
 * an approval open past its window.
 */
export interface Interaction {
  id: InteractionId;
  kind: InteractionKind;
  status: InteractionStatus;
  subject: InteractionSubject;

  createdAt: Date;
  expiresAt: Date;

  /**
   * Who is asking, as the same opaque handle the authorization-request inbox
   * uses. Canonical principal ids do not travel to a screen a stranger may be
   * holding.
   */
  requesterRef?: string;
  /** Whose authority is being asked for. Server-side only. */
  approverPrincipalId?: PrincipalId;

  /**
   * Canonical digest of exactly what is being consented to. Present whenever
   * the interaction authorizes an operation rather than merely a session.
   */
  requestDigest?: string;
  /**
   * Digest of the binding message, so a receipt can prove which words were on
   * the screen without the receipt carrying the words.
   */
  bindingMessageDigest?: string;
  /** Short display string shown identically on both devices (CIBA). */
  bindingMessage?: string;
  /** RFC 9396 authorization_details: constraint, prompt, and consent echo. */
  authorizationDetails: JsonObject[];
  /** Opaque reference to the target. Never a credential or a secret ref. */
  resourceRef?: string;
  /** What the approval must clear before it counts. */
  assuranceRequired?: AssuranceRequirement;
  approvalProof?: ApprovalProof;

  presentedAt?: Date;
  decidedAt?: Date;
  consumedAt?: Date;
  revokedAt?: Date;
  version: number;
}

/**
 * What a caller who has only the reference is allowed to see.
 *
 * Deliberately thin. Before the approver authenticates, an interaction says
 * what kind of question it is and when it lapses — enough to render "someone
 * is asking you to approve a device, sign in to continue" — and nothing that
 * would let a finder of a photographed QR learn who is asking whom for what.
 */
export interface InteractionSummary {
  kind: InteractionKind;
  status: InteractionStatus;
  expiresAt: Date;
  /** True when privileged detail exists behind an authenticated read. */
  requiresApprover: boolean;
}

/**
 * The full view, for the authenticated approver only.
 *
 * `subjectId` is absent by construction: the approver acts through the
 * interaction, so it never needs the row id, and anything that does not need
 * an identifier should not be handed one.
 */
export interface InteractionDetail extends InteractionSummary {
  id: InteractionId;
  requesterRef?: string;
  bindingMessage?: string;
  requestDigest?: string;
  authorizationDetails: JsonObject[];
  resourceRef?: string;
  assuranceRequired?: AssuranceRequirement;
  createdAt: Date;
  decidedAt?: Date;
}
