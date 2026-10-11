/**
 * A person approved this exact model grant (ADR 0178, ADR 0189).
 *
 * `ModelGrantApproved<G>` is the only thing that lets the broker create a root
 * key, and it is minted only here. It says four things about the draft named
 * `G`, and a draft that does not satisfy all four never gets one:
 *
 * - the approver is the person the grant answers to (an agent cannot approve
 *   a grant to itself, nor can one person approve for another);
 * - the approval was given by a person present, with a passkey or as the
 *   unlocked vault's custodian after the `manage_grants` check (which carries
 *   the duress ceilings), and both the sign-in and the approval are recent;
 * - the approval is bound to the digest of this exact draft, so a draft edited
 *   after the person looked at it is a different draft with no approval.
 *
 * The prover answers with a verdict, a proof or a refusal, so the caller keeps
 * its own message. Nothing else in the tree can write the word "approved".
 */

import { type Named, type Proof, defineProof } from "@gdp-ts/core";
import { type ModelGrantDraft, modelGrantDigest } from "../model-keys/root.js";

const ModelGrantApprovedProver = defineProof("ModelGrantApproved");

/** A person approved the draft named `G`. */
export interface ModelGrantApproved<G>
  extends Proof<"ModelGrantApproved", [G]> {}

/** What the approval ceremony reports; written as plain data so this file imports no optional code. */
export type ModelGrantApprovalEvidence = Readonly<{
  approverPrincipalId: string;
  method: "passkey" | "custodian";
  /** When the approver last proved who they are, in ms. */
  authenticatedAt: number;
  approvedAt: number;
  /** The digest the person was shown and approved. */
  boundDigest: string;
}>;

export type ModelGrantApprovalRefusal = Readonly<{
  ok: false;
  code: "not_the_issuer" | "weak_method" | "stale" | "digest_mismatch";
  message: string;
}>;

export type ModelGrantApprovalVerdict<G> =
  | Readonly<{ ok: true; proof: ModelGrantApproved<G>; digest: string }>
  | ModelGrantApprovalRefusal;

const FRESH_MS = 5 * 60 * 1000;
const SKEW_MS = 5_000;

function refusal(
  code: ModelGrantApprovalRefusal["code"],
  message: string,
): ModelGrantApprovalRefusal {
  return { ok: false, code, message };
}

function fresh(at: number, now: number): boolean {
  return Number.isFinite(at) && at <= now + SKEW_MS && now - at <= FRESH_MS;
}

/**
 * Prove a person approved this draft, or say why not. `now` and `sha256` are
 * passed in, so the same answer is given to a test and to a clock.
 */
export async function proveModelGrantApproved<G>(
  draft: Named<G, ModelGrantDraft>,
  evidence: ModelGrantApprovalEvidence,
  now: number,
  sha256: (text: string) => Promise<string>,
): Promise<ModelGrantApprovalVerdict<G>> {
  if (evidence.approverPrincipalId !== draft.value.issuerPrincipalId)
    return refusal(
      "not_the_issuer",
      "only the person a grant answers to can approve it",
    );
  if (evidence.method !== "passkey" && evidence.method !== "custodian")
    return refusal(
      "weak_method",
      "a grant to an app or agent needs a person present",
    );
  if (
    !fresh(evidence.authenticatedAt, now) ||
    !fresh(evidence.approvedAt, now) ||
    evidence.approvedAt < evidence.authenticatedAt
  )
    return refusal("stale", "the approval is too old or from the future");
  const digest = await modelGrantDigest(draft.value, sha256);
  if (digest !== evidence.boundDigest)
    return refusal("digest_mismatch", "the approval was for a different grant");
  return { ok: true, proof: ModelGrantApprovedProver.prove(draft), digest };
}
