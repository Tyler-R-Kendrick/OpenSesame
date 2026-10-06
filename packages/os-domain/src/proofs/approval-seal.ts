/**
 * `SealedApprovalProof` — an `ApprovalProof` that `sealApprovalProof` made
 * (ADR 0086 §7, ADR 0177).
 *
 * `ApprovalProof` is the *recorded* shape: it is what a row carries and what a
 * reader sees, and a Postgres read rebuilds one from jsonb. Anything that
 * *grants* an approval — `interactionMachine.approve` — takes the sealed type
 * instead, so the only value it accepts is one this module produced. A hand
 * written `{ mechanism: "webauthn", assurance: "phishing_resistant", ... }`
 * literal is a compile error there, which is the guarantee
 * `sealApprovalProof` always claimed ("the only way to make an
 * `ApprovalProof`") and the type system did not enforce.
 *
 * The brand is a phantom: a sealed proof is the same plain object at runtime
 * as before, with the same fields and no extra key, so nothing that stores,
 * serializes or compares one changes. This is the only module that may mint
 * it, and it lives under `proofs/` so the gdp-ts lint holds the line on
 * assertions made elsewhere.
 */

import type { ApprovalMechanism, ApprovalProof } from "../interaction.js";
import type { AssuranceLevel } from "../types.js";

declare const SEALED: unique symbol;

/** An approval proof built by `sealApprovalProof`, and by nothing else. */
export interface SealedApprovalProof extends ApprovalProof {
  readonly [SEALED]: true;
}

/**
 * Facts the server itself established about an approval.
 *
 * This is the input to `sealApprovalProof`, and it is a distinct type from
 * `ApprovalProof` precisely so a value that came off the wire cannot be handed
 * in by accident: constructing one is an act of asserting "I, the server,
 * verified these things", and the only place that is true is the route after
 * it has done the verifying.
 */
export interface ServerEstablishedApproval {
  /** The mechanism the route actually verified. Not a client claim. */
  mechanism: ApprovalMechanism;
  /** The digest the interaction stored, which the echo was checked against. */
  boundDigest: string;
  /** The assurance read from the approver's principal record. */
  assurance: AssuranceLevel;
  /** The server's own clock at the moment of verification. */
  verifiedAt: Date;
  /** Non-secret handle for the key or credential that signed, when there is one. */
  credentialRef?: string;
}

/**
 * Seal a proof from server-established facts.
 *
 * The one constructor of a `SealedApprovalProof`. `exactOptionalPropertyTypes`
 * is on, so `credentialRef` is assigned only when present rather than spread
 * in as `undefined` — a proof either names the credential that signed or does
 * not, and an explicit `undefined` is a third state the audit row should never
 * carry.
 */
export function sealApprovalProof(
  facts: ServerEstablishedApproval,
): SealedApprovalProof {
  const proof: ApprovalProof = {
    mechanism: facts.mechanism,
    boundDigest: facts.boundDigest,
    assurance: facts.assurance,
    verifiedAt: facts.verifiedAt,
  };
  if (facts.credentialRef !== undefined) {
    proof.credentialRef = facts.credentialRef;
  }
  /*
   * SAFETY: the brand is a compile-time phantom with no runtime presence, so
   * the object built above is already exactly what a `SealedApprovalProof`
   * is; this is the only place that says so.
   */
  return proof as SealedApprovalProof;
}
