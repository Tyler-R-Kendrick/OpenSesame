import { useId, useState } from "react";
import {
  type LocalAccessRequest,
  localRequestMemberMayDecide,
} from "../../lib/local-access-requests.js";
import type { LocalDirectory } from "../../lib/local-directory.js";
import { loadEnrollmentStateForUnlock } from "../settings/security/duress-unlock-bridge.js";
import { RequestApprovalForm } from "./RequestApprovalForm.js";
import { decideAccessRequestWithDuressGate } from "./request-approval-decide.js";

export function RequestApproval({
  tomb,
  row,
  directory,
  run,
  close,
}: {
  tomb: string;
  row: LocalAccessRequest;
  directory: LocalDirectory;
  run: (
    action: () => Promise<LocalAccessRequest> | Promise<void>,
    success: string,
  ) => Promise<boolean>;
  close: () => void;
}) {
  const id = useId();
  const approvers = directory.entries.filter(
    (entry) =>
      entry.kind === "person" &&
      entry.enabled &&
      directory.memberships.some(
        (member) =>
          member.principalId === entry.id &&
          localRequestMemberMayDecide(row, member),
      ),
  );
  const [principalId, setPrincipalId] = useState(approvers[0]?.id ?? "");
  const [approvalCode, setApprovalCode] = useState("");
  const state = loadEnrollmentStateForUnlock();
  const approvalDuressArmed = Boolean(
    state?.armed &&
      state.triggers.some((t) => t.slot.profileId === "approval-duress"),
  );

  async function decide(decision: "approve" | "deny") {
    const result = await decideAccessRequestWithDuressGate({
      tomb,
      row,
      principalId,
      decision,
      approvalCode,
      run,
    });
    if (result === "closed") close();
  }

  if (row.status !== "pending") return null;

  return (
    <RequestApprovalForm
      id={id}
      approvalDuressArmed={approvalDuressArmed}
      approvalCode={approvalCode}
      setApprovalCode={setApprovalCode}
      principalId={principalId}
      setPrincipalId={setPrincipalId}
      approvers={approvers}
      onApprove={() => void decide("approve")}
      onDeny={() => void decide("deny")}
    />
  );
}
