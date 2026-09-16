/**
 * Shared merge for MemoryRepositories.interactions.updateWithVersion.
 */

import type { Interaction, InteractionKind } from "@opensesame/os-domain";
import { interactionMachine } from "@opensesame/os-domain";
import { ConflictError } from "./interfaces.js";

export type InteractionPatch = {
  status?: Interaction["status"];
  approverPrincipalId?: Interaction["approverPrincipalId"];
  approvalProof?: Interaction["approvalProof"];
  presentedAt?: Interaction["presentedAt"];
  decidedAt?: Interaction["decidedAt"];
  consumedAt?: Interaction["consumedAt"];
  revokedAt?: Interaction["revokedAt"];
};

export function mergeInteractionPatch(
  current: Interaction,
  patch: InteractionPatch,
  liveForSubject: (
    kind: InteractionKind,
    subjectId: string,
  ) => Interaction | undefined,
): Interaction {
  const merged: Interaction = {
    ...current,
    version: current.version + 1,
  };
  if (patch.status !== undefined) merged.status = patch.status;
  if (patch.approverPrincipalId !== undefined) {
    merged.approverPrincipalId = patch.approverPrincipalId;
  }
  if (patch.approvalProof !== undefined) {
    merged.approvalProof = patch.approvalProof;
  }
  if (patch.presentedAt !== undefined) merged.presentedAt = patch.presentedAt;
  if (patch.decidedAt !== undefined) merged.decidedAt = patch.decidedAt;
  if (patch.consumedAt !== undefined) merged.consumedAt = patch.consumedAt;
  if (patch.revokedAt !== undefined) merged.revokedAt = patch.revokedAt;
  if (!interactionMachine.isTerminal(merged.status)) {
    const holder = liveForSubject(
      merged.subject.kind,
      merged.subject.subjectId,
    );
    if (holder && holder.id !== merged.id) {
      throw new ConflictError(
        `interaction already live for subject: ${merged.subject.kind}/${merged.subject.subjectId}`,
      );
    }
  }
  return merged;
}
