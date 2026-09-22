/**
 * Access request decide path, including optional approval-duress gate.
 */

import {
  type LocalAccessRequest,
  decideLocalAccessRequest,
} from "../../lib/local-access-requests.js";
import { gateAccessApprovalDecision } from "./duress-approval-bridge.js";

export async function decideAccessRequestWithDuressGate(input: {
  tomb: string;
  row: LocalAccessRequest;
  principalId: string;
  decision: "approve" | "deny";
  approvalCode: string;
  run: (
    action: () => Promise<LocalAccessRequest> | Promise<void>,
    success: string,
  ) => Promise<boolean>;
}): Promise<"closed" | "stayed"> {
  const gate = await gateAccessApprovalDecision({
    decision: input.decision,
    code: input.approvalCode,
  });
  if (
    gate.kind === "need_code" ||
    gate.kind === "deny" ||
    gate.kind === "duress"
  ) {
    return "stayed";
  }
  const ok = await input.run(
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
  return ok ? "closed" : "stayed";
}
