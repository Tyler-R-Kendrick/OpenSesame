/**
 * Three digests, three questions (finding F08).
 *
 * A single `requestDigest` used to answer three different questions at once,
 * and conflating them is how a verifier binds a holder's signature to the wrong
 * thing without anyone noticing. The three are:
 *
 * - **operation** — *what is being asked*, independent of transport. The DCQL
 *   query and the caller's transaction-data content, and nothing ephemeral: no
 *   nonce, no state, no response URI, no expiry. Two requests for the same
 *   operation, minted a second apart with fresh nonces, share this digest. It
 *   is what a receipt should record as "the operation", and it is stable enough
 *   to deduplicate or correlate two attempts at one authorization.
 *
 * - **approval** — *what the human agreed to*. In an OpenSesame deployment this
 *   is the ADR 0086 interaction digest (`canonicalRequestDigest`), supplied by
 *   the caller, and it is the value the holder's key-binding signature is bound
 *   to and that `VerifiedPresentation.boundDigest` returns. That is the whole
 *   point: `approve()` refuses a proof whose `boundDigest` is not the
 *   interaction's digest, so the presentation must commit to *that* digest, not
 *   to a protocol-internal one this package computed for its own bookkeeping.
 *   Absent an interaction, a standalone verifier has no external notion of "what
 *   was approved" beyond the wire request, so it falls back to the protocol
 *   digest — the pre-F08 behaviour, preserved exactly for that case.
 *
 * - **protocol** — *which wire request this is*. Every field that determines the
 *   transport exchange: audience, client id, response mode and URI, nonce,
 *   state, expiry, the DCQL query and the caller's transaction data. This is the
 *   value a request session stores and cross-checks a response against, so that
 *   one authorization request settles exactly one interaction on one transport.
 *
 * The separation matters most when the approval digest is *not* the protocol
 * digest. Before F08 the transaction-data binding entry carried the protocol
 * digest, so a holder's signature attested to "this OpenID4VP wire request" —
 * a fact meaningful only inside this package. After F08 it carries the approval
 * digest, so the signature attests to the operation a human read on another
 * screen, which is the fact the rest of the system checks.
 */

import { type JsonObject, digestManifest } from "@opensesame/os-domain";

/** Domain separation so an operation digest can never collide with a protocol one. */
export const OPERATION_DIGEST_PURPOSE = "opensesame:openid4vp:operation:v1";

export interface RequestDigests {
  /** The stable, transport-independent digest of the operation being asked. */
  readonly operation: string;
  /** The digest the holder's signature is bound to and `boundDigest` returns. */
  readonly approval: string;
  /** The digest of the full wire request, stored and cross-checked per session. */
  readonly protocol: string;
}

/**
 * The digest of *what is being asked*, independent of transport.
 *
 * Covers the DCQL query (already projected to its wire JSON) and the caller's
 * transaction-data entries (their exact encoded strings), under a purpose tag.
 * Nothing ephemeral is inside it — that is the property that makes it stable
 * across retries and useless as a cross-request nonce.
 */
export interface OperationDigestInput {
  readonly dcqlQuery: JsonObject;
  readonly transactionData: readonly string[];
}

export function operationDigest(input: OperationDigestInput): string {
  return digestManifest({
    purpose: OPERATION_DIGEST_PURPOSE,
    dcql_query: input.dcqlQuery,
    transaction_data: [...input.transactionData],
  });
}

/**
 * The digest of the full wire request.
 *
 * A thin wrapper over the shared canonical-manifest digest so the protocol
 * digest is computed in exactly one place and reads as a decision at its call
 * site rather than as an incidental `digestManifest`.
 */
export function protocolDigest(core: JsonObject): string {
  return digestManifest(core);
}

/**
 * Derive all three digests from a request under construction.
 *
 * `approvalBindingDigest` is the caller's ADR 0086 interaction digest when
 * there is one. When there is not, approval degrades to the protocol digest, so
 * a verifier used with no interaction layer behaves exactly as it did before
 * F08 and every existing binding stays valid.
 */
export interface DeriveRequestDigestsInput {
  readonly core: JsonObject;
  readonly dcqlQuery: JsonObject;
  readonly callerTransactionData: readonly string[];
  readonly approvalBindingDigest?: string | undefined;
}

export function deriveRequestDigests(
  input: DeriveRequestDigestsInput,
): RequestDigests {
  const protocol = protocolDigest(input.core);
  const operation = operationDigest({
    dcqlQuery: input.dcqlQuery,
    transactionData: input.callerTransactionData,
  });
  const approval = input.approvalBindingDigest ?? protocol;
  return { operation, approval, protocol };
}
