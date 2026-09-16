/**
 * The three digests a wallet-native interaction is bound by (ADR 0086, ADR 0084).
 *
 * `crypto/request-digest.ts` states the invariant this file carries forward:
 *
 *     displayed operation == approved operation == executed operation
 *
 * What it did not do was keep the *different* digests a single approval rests
 * on apart from one another. There are three, and confusing any two is a real
 * defect, not a naming quibble:
 *
 * - the **operation** digest — *what* is being authorized (kind, subject,
 *   details, amount, payee, message, resource, window, and the semantic
 *   revision of that content);
 * - the **approval-binding** digest — *which decision*, over which operation,
 *   under which effective policy (ADR 0084 §"bound to its transaction"). A
 *   WebAuthn activation commits to this, so an activation minted for one
 *   request, one verb, or one policy can never settle another;
 * - the **presentation-request** digest — *which verifiable-presentation
 *   request* an OpenID4VP holder is answering (verifier origin, client id,
 *   nonce, requested claims, purpose), optionally bound to the operation the
 *   presentation authorizes.
 *
 * They are branded string types. The brand is erased at runtime — a digest is
 * a public value and stays a plain string on the wire — but at compile time it
 * stops an operation digest being passed where an approval binding is wanted,
 * which is the mix-up that turns "approved *this*" back into "approved
 * *something*".
 *
 * Canonicalization is versioned. Each purpose string carries
 * `:v{INTERACTION_DIGEST_VERSION}`; a field that ought to be covered later is
 * added here and the version is bumped, because silently widening what is
 * hashed breaks every digest already stored and silently narrowing it is how a
 * field the user sees and the executor ignores gets in.
 */

import { createHash } from "node:crypto";
import type { AuthorizationDetail } from "../authorization-details.js";
import { canonicalize } from "./digest.js";

/**
 * The canonicalization version. Part of every purpose string, so a digest
 * computed under one revision of these rules never silently compares equal to
 * one computed under another.
 */
export const INTERACTION_DIGEST_VERSION = 1 as const;

declare const digestBrand: unique symbol;

/**
 * A digest string tagged with what it is a digest *of*.
 *
 * Structural typing would let any `string` stand in for any digest, which is
 * exactly the confusion these types exist to prevent, so the brand is nominal.
 */
type BrandedDigest<Tag extends string> = string & {
  readonly [digestBrand]: Tag;
};

/** `sha256:<hex>` over the operation an approval authorizes. */
export type OperationDigest = BrandedDigest<"operation">;
/** `sha256:<hex>` over a decision, its operation, and the effective policy. */
export type ApprovalBindingDigest = BrandedDigest<"approval-binding">;
/** `sha256:<hex>` over a verifiable-presentation request. */
export type PresentationRequestDigest = BrandedDigest<"presentation-request">;

const OPERATION_PURPOSE = `opensesame:interaction-operation:v${INTERACTION_DIGEST_VERSION}`;
const APPROVAL_BINDING_PURPOSE = `opensesame:approval-binding:v${INTERACTION_DIGEST_VERSION}`;
const PRESENTATION_REQUEST_PURPOSE = `opensesame:presentation-request:v${INTERACTION_DIGEST_VERSION}`;

/**
 * The decision an approval binding fixes.
 *
 * A denial is bound as tightly as an approval: without the verb in the digest,
 * an activation gathered to approve a request could be replayed to deny the
 * one that replaced it, or the reverse.
 */
export type ApprovalVerb = "approve" | "deny";

/**
 * Length-prefixed field write.
 *
 * Without the length prefix, moving text across a field boundary produces the
 * same byte stream, so an attacker who controls one field controls the
 * meaning of the next. The prefix is why `("AliceCo", "123")` and
 * `("AliceCo123", "")` do not collide.
 */
function field(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(String(Buffer.byteLength(value, "utf8")));
  hash.update("\0");
  hash.update(value, "utf8");
}

function finish(hash: ReturnType<typeof createHash>): string {
  return `sha256:${hash.digest("hex")}`;
}

/**
 * The exact content an operation approval is bound to.
 *
 * Closed by design. `revision` is the semantic revision of the operation
 * content (ADR 0086, and the version/revision split concurrency draws): the
 * lifecycle `version` on an interaction bumps on every transition — presented,
 * awaiting, approved — whereas `revision` bumps only when what is being
 * approved changes. Folding it into the digest closes the revert-replay gap:
 * content reverted to a previously approved state still yields a new digest,
 * because it is a later revision of the operation, so a proof gathered for the
 * earlier revision does not carry over.
 */
export interface CanonicalOperation {
  /** ADR 0009 kind. A payment approval must never settle a claim. */
  kind: string;
  /** The fronted ceremony as `kind:id`; two identical operations differ here. */
  subject: string;
  /** Opaque approver handle. Never a canonical principal id. */
  approverRef: string;
  /** Opaque requester handle. */
  requesterRef: string;
  /** RFC 9396 details, order preserved: a list of things being permitted. */
  authorizationDetails: readonly AuthorizationDetail[];
  /** The sentence shown identically on both screens. */
  bindingMessage: string;
  /** Opaque target handle, when the operation has one. */
  resourceRef?: string;
  /** End of the approval's validity, ISO-8601. Inside the digest on purpose. */
  expiresAt: string;
  /** Semantic revision of the operation content. Distinct from lifecycle version. */
  revision: number;
}

/**
 * The operation digest.
 *
 * Unkeyed: an independent executor — the holder's own daemon in the relay case
 * of ADR 0046 — must be able to recompute it from the request it is about to
 * run and compare, and a MAC would make it verifiable only by the minter. Its
 * integrity comes from being compared against a stored value, not from being
 * unforgeable in isolation.
 */
export function operationDigest(op: CanonicalOperation): OperationDigest {
  const hash = createHash("sha256");
  field(hash, OPERATION_PURPOSE);
  field(hash, op.kind);
  field(hash, op.subject);
  field(hash, op.approverRef);
  field(hash, op.requesterRef);
  field(hash, canonicalize([...op.authorizationDetails]));
  field(hash, op.bindingMessage);
  field(hash, op.resourceRef ?? "");
  field(hash, op.expiresAt);
  field(hash, String(op.revision));
  const digest = finish(hash);
  /* SAFETY: `digest` is the `sha256:<hex>` string finish() just produced from
   * the operation fields; the brand is a compile-time tag with no runtime
   * representation, so tagging the string asserts nothing about its bytes. */
  return digest as OperationDigest;
}

/**
 * The exact content an approval-binding digest fixes (ADR 0084).
 *
 * Three things and no more: the operation being decided, the decision verb,
 * and the digest of the effective policy under which it is being decided. A
 * step-up activation commits to this digest, so moving the operation, flipping
 * the verb, or changing the policy after the fact all invalidate it.
 */
export interface CanonicalApprovalBinding {
  operation: OperationDigest;
  verb: ApprovalVerb;
  /**
   * Digest of the effective policy the decision was evaluated under. Opaque
   * here: this module fixes *that* a policy was in force, and the policy plane
   * owns what the bytes mean.
   */
  policyDigest: string;
}

/**
 * The approval-binding digest.
 *
 * This is the value a phishing-resistant activation is spent against by a
 * durable compare-and-set (ADR 0084). Because the operation digest already
 * length-prefixes its own inputs, embedding it whole here is safe: the verb
 * and policy cannot bleed into it.
 */
export function approvalBindingDigest(
  binding: CanonicalApprovalBinding,
): ApprovalBindingDigest {
  const hash = createHash("sha256");
  field(hash, APPROVAL_BINDING_PURPOSE);
  field(hash, binding.operation);
  field(hash, binding.verb);
  field(hash, binding.policyDigest);
  const digest = finish(hash);
  /* SAFETY: `digest` is the `sha256:<hex>` string finish() just produced from
   * the operation, verb and policy fields; the brand is a compile-time tag
   * with no runtime representation, so tagging asserts nothing about its bytes. */
  return digest as ApprovalBindingDigest;
}

/**
 * The exact content a presentation-request digest fixes (ADR 0086, OpenID4VP).
 *
 * The verifier origin is the *exact* origin, because a presentation request
 * from `https://evil.example` and one from `https://bank.example` requesting
 * the same claims are different requests and a holder must not answer one
 * believing it is the other. `nonce` is what proves a presentation answers
 * this request and not a replayed earlier one.
 */
export interface CanonicalPresentationRequest {
  /** Exact verifier origin, scheme and host and port. */
  verifierOrigin: string;
  /** OpenID4VP `client_id`. */
  clientId: string;
  /** Single-use nonce the response must echo. */
  nonce: string;
  /** Where the presentation is returned. */
  responseUri: string;
  /** Requested claim paths, order preserved. */
  requestedClaims: readonly string[];
  /** Human-readable purpose shown to the holder. */
  purpose: string;
  /**
   * The operation this presentation authorizes, when it authorizes one.
   * Binding it here is what stops a presentation gathered for one operation
   * satisfying another (ADR 0086 §"the reference authorizes nothing").
   */
  operation?: OperationDigest;
}

/**
 * The presentation-request digest.
 *
 * `requestedClaims` is canonicalized with order preserved, matching the
 * operation digest's treatment of `authorization_details`: reordering the
 * claims is a change a holder could notice, so it must change the digest.
 */
export function presentationRequestDigest(
  request: CanonicalPresentationRequest,
): PresentationRequestDigest {
  const hash = createHash("sha256");
  field(hash, PRESENTATION_REQUEST_PURPOSE);
  field(hash, request.verifierOrigin);
  field(hash, request.clientId);
  field(hash, request.nonce);
  field(hash, request.responseUri);
  field(hash, canonicalize([...request.requestedClaims]));
  field(hash, request.purpose);
  field(hash, request.operation ?? "");
  const digest = finish(hash);
  /* SAFETY: `digest` is the `sha256:<hex>` string finish() just produced from
   * the presentation-request fields; the brand is a compile-time tag with no
   * runtime representation, so tagging asserts nothing about its bytes. */
  return digest as PresentationRequestDigest;
}

/**
 * Compare two digests of the same brand for equality.
 *
 * A plain `===` would be correct — a digest is public, so a timing channel
 * leaks nothing an attacker cannot already compute — but this is written as an
 * explicit total function so every call site reads as a decision and there is
 * one place to change if that reasoning ever stops holding. The shared brand
 * in the signature is the other half: it will not compare an operation digest
 * against an approval binding at all.
 */
export function digestEquals<Tag extends string>(
  a: BrandedDigest<Tag>,
  b: BrandedDigest<Tag>,
): boolean {
  return a.length === b.length && a === b;
}
