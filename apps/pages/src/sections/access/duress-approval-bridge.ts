/**
 * Production entry for SC-APPROVAL-DURESS: gate an access-approval decision
 * through evaluateApprovalCeremony when an approval-duress profile is armed.
 */

import { evaluateApprovalCeremony } from "../../lib/duress/ceremony/approval.js";
import { loadEnrollmentStateForUnlock } from "../settings/security/duress-unlock-bridge.js";

export type ApprovalDuressGateResult =
  | { kind: "inactive" }
  | { kind: "need_code" }
  | { kind: "proceed" }
  | { kind: "deny"; reason: string }
  | { kind: "duress"; profileId: string };

const APPROVAL_PROFILE_ID = "approval-duress";

function armedApprovalState() {
  const state = loadEnrollmentStateForUnlock();
  if (!state?.armed) return null;
  const hasApproval = state.triggers.some(
    (t) => t.slot.profileId === APPROVAL_PROFILE_ID,
  );
  if (!hasApproval) return null;
  return state;
}

/**
 * Before settling approve/deny on a local access request.
 * Deny never fabricates success. Duress returns the profile for activation.
 */
export async function gateAccessApprovalDecision(input: {
  decision: "approve" | "deny";
  code?: string;
  operation?: "sign" | "mint" | "invoke";
}): Promise<ApprovalDuressGateResult> {
  const state = armedApprovalState();
  if (!state) return { kind: "inactive" };

  if (
    input.decision === "deny" &&
    (input.code === undefined || input.code === "")
  ) {
    return { kind: "proceed" };
  }

  const code = input.code?.trim() ?? "";
  if (code.length === 0) return { kind: "need_code" };

  const result = await evaluateApprovalCeremony({
    operation: input.operation ?? "invoke",
    code,
    state,
    principalKind: "human_owner",
    expectedPolicyRevision: state.policyRevision,
    approvalProfileIds: [APPROVAL_PROFILE_ID],
  });

  if (result.outcome === "duress") {
    return { kind: "duress", profileId: result.match.profileId };
  }
  if (result.outcome === "deny") {
    return { kind: "deny", reason: result.reason };
  }
  return { kind: "proceed" };
}
