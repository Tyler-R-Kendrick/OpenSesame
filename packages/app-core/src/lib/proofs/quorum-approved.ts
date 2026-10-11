/**
 * A quorum approved this standing share (ADR 0178, ADR 0187).
 *
 * `QuorumApproved<T>` is the third way to hold a `ShareWriteAuthority<T>`,
 * beside `ManageGrants` (a person, with `manage_grants`) and `SystemShareWrite`
 * (system code). It is the authority for the owner-absent case: the owner is
 * not there to be asked, and enough of the people they named to ask have
 * approved this exact request.
 *
 * It is minted only here, from what a quorum ledger says about its request,
 * written as plain data so this core file imports no optional code. The
 * checker answers with a verdict, a proof or a refusal, so the caller keeps its
 * own message. The proof says nothing about *which* share: the caller writes
 * the share the approved request carries, field for field, and nothing else.
 */

import { type Named, type Proof, defineProof } from "@gdp-ts/core";

const QuorumApprovedProver = defineProof("QuorumApproved");

/** A quorum of the circle approved a grant in the tomb named `T`. */
export interface QuorumApproved<T> extends Proof<"QuorumApproved", [T]> {}

/** What a quorum ledger reports about its request. */
export type QuorumLedgerVerdict = Readonly<{
  state: string;
  operation: string;
  circleId: string;
  requestDigest: string;
  approvedBy: readonly string[];
  validUntil: string;
}>;

export type QuorumRefusal = Readonly<{
  ok: false;
  code: "not_authorized" | "wrong_operation" | "lapsed";
  message: string;
}>;

export type QuorumVerdict<T> =
  | Readonly<{
      ok: true;
      proof: QuorumApproved<T>;
      circleId: string;
      requestDigest: string;
      approvedBy: readonly string[];
    }>
  | QuorumRefusal;

/**
 * Prove a quorum approved a grant in this tomb, or say why not. `now` is
 * passed in so the same answer is given to a test and to a clock.
 */
export function proveQuorumApproved<T>(
  tomb: Named<T, string>,
  verdict: QuorumLedgerVerdict,
  now: number,
): QuorumVerdict<T> {
  if (verdict.operation !== "grant-access") {
    return {
      ok: false,
      code: "wrong_operation",
      message: "a quorum approved something other than a grant",
    };
  }
  if (verdict.state !== "authorized") {
    return {
      ok: false,
      code: "not_authorized",
      message: "the quorum has not authorized this grant, or already used it",
    };
  }
  if (now > new Date(verdict.validUntil).getTime()) {
    return { ok: false, code: "lapsed", message: "the request has lapsed" };
  }
  return {
    ok: true,
    proof: QuorumApprovedProver.prove(tomb),
    circleId: verdict.circleId,
    requestDigest: verdict.requestDigest,
    approvedBy: verdict.approvedBy,
  };
}
