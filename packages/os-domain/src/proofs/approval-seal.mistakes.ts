/**
 * Mistakes the type checker must keep refusing (ADR 0177).
 *
 * `interactionMachine.approve` takes a `SealedApprovalProof`. Every
 * `@ts-expect-error` below is a way to hand it an approval nobody sealed;
 * `tsc` fails the build if one starts to compile. Nothing in this file runs.
 */

import type { ApprovalProof, Interaction } from "../interaction.js";
import { approve } from "../machines/interaction.js";
import type { PrincipalId } from "../types.js";
import { sealApprovalProof } from "./approval-seal.js";

export function approvalSealMistakes(
  interaction: Interaction,
  approver: PrincipalId,
  recorded: ApprovalProof,
  now: Date,
): void {
  const sealed = sealApprovalProof({
    mechanism: "webauthn",
    boundDigest: "sha256:digest",
    assurance: "phishing_resistant",
    verifiedAt: now,
  });

  // The honest path compiles.
  approve(interaction, { approverPrincipalId: approver, proof: sealed, now });

  approve(interaction, {
    approverPrincipalId: approver,
    // @ts-expect-error — a hand-written literal is not a sealed proof.
    proof: {
      mechanism: "webauthn",
      boundDigest: "sha256:digest",
      assurance: "phishing_resistant",
      verifiedAt: now,
    },
    now,
  });

  approve(interaction, {
    approverPrincipalId: approver,
    // @ts-expect-error — a proof read back from a row is a record, not a seal.
    proof: recorded,
    now,
  });
}
