import {
  type LocalAccessRequest,
  decideLocalAccessRequest,
  localRequestMemberMayDecide,
} from "../../lib/local-access-requests.js";
/**
 * View-model logic for `RequestApproval` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import type {
  LocalDirectory,
  LocalIdentity,
} from "../../lib/local-directory.js";
import { loadEnrollmentStateForUnlock } from "../settings/security/duress-unlock-bridge.js";
import { gateAccessApprovalDecision } from "./duress-approval-bridge.js";

export function listRequestApprovers(
  directory: LocalDirectory,
  row: LocalAccessRequest,
): LocalIdentity[] {
  return directory.entries.filter(
    (entry) =>
      entry.kind === "person" &&
      entry.enabled &&
      directory.memberships.some(
        (member) =>
          member.principalId === entry.id &&
          localRequestMemberMayDecide(row, member),
      ),
  );
}

export function approvalDuressArmed(): boolean {
  const state = loadEnrollmentStateForUnlock();
  return Boolean(
    state?.armed &&
      state.triggers.some((t) => t.slot.profileId === "approval-duress"),
  );
}

export type AccessRequestRun = (
  action: () => Promise<LocalAccessRequest> | Promise<void>,
  success: string,
) => Promise<boolean>;

export type DecideAccessRequestInput = Readonly<{
  tomb: string;
  row: LocalAccessRequest;
  principalId: string;
  decision: "approve" | "deny";
  approvalCode: string;
  run: AccessRequestRun;
}>;

export async function decideAccessRequestWithDuressGate(
  input: DecideAccessRequestInput,
): Promise<boolean> {
  const gate = await gateAccessApprovalDecision({
    decision: input.decision,
    code: input.approvalCode,
  });
  if (
    gate.kind === "need_code" ||
    gate.kind === "deny" ||
    gate.kind === "duress"
  ) {
    return false;
  }
  return input.run(
    () =>
      decideLocalAccessRequest(input.tomb, {
        ...input.row,
        principalId: input.principalId,
        decision: input.decision,
      }),
    input.decision === "approve"
      ? "Request approved; awaiting single-use consumption by its requester."
      : "Request denied.",
  );
}
