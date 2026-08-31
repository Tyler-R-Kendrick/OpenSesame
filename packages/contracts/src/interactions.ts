import { z } from "zod";
import { AuthorizationDetailSchema } from "./authorization-requests.js";
import { AssuranceLevelSchema } from "./principals.js";

/**
 * Wire contracts for the cross-device interaction layer (ADR 0086).
 *
 * These shapes describe `/v1/interactions` and the canonical short link
 * `/i/:ref` — not `/interaction`, which is the oidc-provider login/consent
 * slot and a different thing entirely.
 *
 * Two asymmetries are deliberate and are the whole reason this file is not
 * simply the domain types re-declared:
 *
 * 1. **What the server derives never appears in a request.** The binding
 *    message, the request digest, the reference, the expiry instant and the
 *    proof's `verifiedAt` are all outputs. A requester who could write the
 *    sentence the approver reads could make it disagree with what executes,
 *    and a client who could write `verifiedAt` could hold an approval open
 *    past its window.
 * 2. **What the summary omits, it omits on purpose.** `InteractionSummary`
 *    is what a stranger holding a photographed QR is allowed to learn; it
 *    carries no requester, no binding message, no digest, no authorization
 *    details, and no subject id. `InteractionDetail` — everything behind an
 *    authenticated approver — is a separate schema for that reason, rather
 *    than the same schema with optional fields, so an accidental widening is
 *    a type error and not a leak.
 */

export const InteractionKindSchema = z.enum([
  "device_authorization",
  "pairing",
  "claim",
  "grant_claim",
  "authorization_request",
  "transaction_authorization",
]);

export const InteractionStatusSchema = z.enum([
  "pending",
  "presented",
  "awaiting_approval",
  "approved",
  "denied",
  "consumed",
  "expired",
  "revoked",
]);

export const ApprovalMechanismSchema = z.enum([
  "webauthn",
  "openid4vp",
  "session_reauth",
  "out_of_band",
]);

/**
 * The stable error vocabulary for every interaction route.
 *
 * Closed and shared across the surfaces, because a client that has to branch
 * on prose ends up branching on the HTTP status alone, and the statuses
 * collapse distinct outcomes: `interaction_revoked`, `interaction_consumed`
 * and `interaction_settled` are all 409 and mean three different things to a
 * caller deciding whether to retry, re-issue, or stop.
 *
 * `interaction_not_found` is the single answer to a malformed reference, a
 * forged MAC, an id that never existed, and an interaction the caller is not
 * entitled to. Distinguishing any of those would turn the resolve endpoint
 * into an oracle for which references and which principals are real.
 *
 * `approval_required` covers spending an interaction that carries no approval
 * to spend — never approved, or denied. It is not "you are not signed in":
 * the caller is authenticated and is the right caller, and what is missing is
 * the ceremony, which is exactly the distinction an authenticated-session-is-
 * not-an-approval system has to be able to state.
 */
export const InteractionErrorCodeSchema = z.enum([
  "interaction_not_found",
  "interaction_expired",
  "interaction_revoked",
  "interaction_consumed",
  /** Already approved or denied: a decision exists and does not move again. */
  "interaction_settled",
  /** One live interaction per ceremony; another already holds the slot. */
  "interaction_already_live",
  "approval_required",
  "digest_mismatch",
  "unsupported_kind",
  "invalid_request",
  "rate_limited",
]);

/**
 * The ceremony an interaction fronts.
 *
 * `subjectId` is the fronted record's own primary key. It travels *inbound*
 * only: the creator already knows which device-authorization session or claim
 * they are wrapping, and no response ever carries it back, so a reference can
 * never be turned into an id for the row behind it.
 */
export const InteractionSubjectSchema = z.object({
  kind: InteractionKindSchema,
  subjectId: z.string().min(1).max(256),
});

export const CreateInteractionSchema = z.object({
  kind: InteractionKindSchema,
  subject: InteractionSubjectSchema,
  /**
   * The approver's inbox handle, obtained from
   * `GET /v1/authorization-requests/inbox-ref` by its owner. The same handle
   * family the authorization-request inbox uses, and for the same reason:
   * knowing who somebody is must not be enough to put text in front of them.
   */
  approverRef: z.string().min(8).max(256),
  authorizationDetails: z.array(AuthorizationDetailSchema).min(1).max(32),
  /** Opaque handle for the target. Never a credential or a secret reference. */
  resourceRef: z.string().min(1).max(512).optional(),
  /**
   * Seconds. Bounded at both ends: below the floor a person cannot answer in
   * time, and above the ceiling a photographed QR stays answerable for longer
   * than anyone remembers issuing it. The window is hashed into the digest,
   * so it is part of what gets approved rather than a server-side detail.
   */
  ttlSeconds: z.number().int().min(30).max(3600).optional(),
});

/**
 * What creating an interaction hands back.
 *
 * `url` is the canonical HTTPS form — `<publicUrl>/i/<ref>` — because a
 * custom scheme cannot be opened by a camera app, cannot be a wallet barcode
 * value that degrades gracefully, and cannot be checked against the browser's
 * origin model. `bindingMessage` is echoed so the requester's own screen shows
 * the same sentence the approver will read; it is server-derived, so echoing
 * it is a display convenience and never an input.
 */
export const InteractionCreatedResponseSchema = z.object({
  ref: z.string().min(8),
  url: z.string().url(),
  requestDigest: z.string().min(16),
  bindingMessage: z.string().min(1),
  expiresAt: z.string().datetime(),
  status: InteractionStatusSchema,
});

/**
 * Everything the holder of a bare reference may learn.
 *
 * Enough to render "someone is asking you to approve a device — sign in to
 * continue", and nothing that says who is asking whom for what.
 */
export const InteractionSummaryResponseSchema = z.object({
  kind: InteractionKindSchema,
  status: InteractionStatusSchema,
  expiresAt: z.string().datetime(),
  requiresApprover: z.boolean(),
});

/**
 * The authenticated approver's view.
 *
 * No `subjectId` and no approval proof: the approver acts *through* the
 * interaction and never needs the fronted row's id, and the proof is a record
 * for executors and auditors rather than something a decision screen reads
 * back. `assuranceRequired` is likewise absent — nothing on these routes sets
 * one yet, and a field the server never populates is a contract promise
 * nothing keeps.
 */
export const InteractionDetailResponseSchema =
  InteractionSummaryResponseSchema.extend({
    id: z.string().min(1),
    requesterRef: z.string().optional(),
    bindingMessage: z.string().optional(),
    requestDigest: z.string().optional(),
    authorizationDetails: z.array(AuthorizationDetailSchema),
    resourceRef: z.string().optional(),
    createdAt: z.string().datetime(),
    decidedAt: z.string().datetime().optional(),
  });

export const InteractionListResponseSchema = z.object({
  interactions: z.array(InteractionDetailResponseSchema),
});

/**
 * The verified approval, reduced to what is safe to keep.
 *
 * No assertion bytes, no verifiable presentation, no JOSE: those are proof
 * *inputs*, checked once at the protocol edge and dropped. `verifiedAt` is
 * absent by construction — the server stamps it from its own clock, because a
 * client that can move that timestamp can present a stale ceremony as fresh.
 *
 * This is the *stored* shape. It is deliberately not an accepted request
 * shape: see `ApproveInteractionSchema` for why a client may not hand the
 * server a proof it has not itself verified.
 */
export const ApprovalProofSchema = z.object({
  mechanism: ApprovalMechanismSchema,
  /**
   * The digest this proof was computed over. Checked against the stored
   * digest before anything is recorded, so a proof minted for one request
   * cannot settle another.
   */
  boundDigest: z.string().min(16).max(256),
  /** Non-secret handle for the key or credential that signed. */
  credentialRef: z.string().min(1).max(256).optional(),
  assurance: AssuranceLevelSchema,
});

/**
 * Approving echoes the digest, and carries nothing else.
 *
 * An earlier shape took the whole `ApprovalProof` from the request body —
 * mechanism, assurance level, credential handle — and stored and audited it.
 * That was evidence manufacture: the server verified no assertion and no
 * presentation, so a caller could write `mechanism: "webauthn"`,
 * `assurance: "phishing_resistant"` into an audit trail having touched no key
 * at all. A record that overstates what was checked is worse than no record,
 * because it is the record a reviewer trusts.
 *
 * So the proof is built server-side from what the server actually
 * established, which today is the authenticated session and the approver's
 * own assurance level. Binding a separately verified step-up — the passkey
 * assertion and TOTP checks that `/v1/mfa/*` really does verify — to a
 * specific interaction is the work that would let a stronger mechanism be
 * recorded honestly; until it exists, none is.
 *
 * The echo stays: it says "this is the request I was shown", and comparing it
 * against the stored digest is what stops a stale screen settling the request
 * that replaced it.
 */
export const ApproveInteractionSchema = z.object({
  requestDigest: z.string().min(16).max(256),
});

/**
 * Denying echoes the digest too.
 *
 * A refusal needs no proof — refusing only ever removes authority — but it
 * still has to be a refusal of *this* request. Without the echo, a stale tab
 * showing a superseded request could deny the one that replaced it.
 */
export const DenyInteractionSchema = z.object({
  requestDigest: z.string().min(16).max(256),
});

export type InteractionKind = z.infer<typeof InteractionKindSchema>;
export type InteractionStatus = z.infer<typeof InteractionStatusSchema>;
export type ApprovalMechanism = z.infer<typeof ApprovalMechanismSchema>;
export type InteractionErrorCode = z.infer<typeof InteractionErrorCodeSchema>;
export type CreateInteraction = z.infer<typeof CreateInteractionSchema>;
export type InteractionCreatedResponse = z.infer<
  typeof InteractionCreatedResponseSchema
>;
export type InteractionSummaryResponse = z.infer<
  typeof InteractionSummaryResponseSchema
>;
export type InteractionDetailResponse = z.infer<
  typeof InteractionDetailResponseSchema
>;
export type ApproveInteraction = z.infer<typeof ApproveInteractionSchema>;
export type DenyInteraction = z.infer<typeof DenyInteractionSchema>;
