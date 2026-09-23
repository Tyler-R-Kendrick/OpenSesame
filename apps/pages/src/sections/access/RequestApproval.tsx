import {
  type LocalAccessRequest,
  decideLocalAccessRequest,
  localRequestMemberMayDecide,
} from "@opensesame/app-core/lib/local-access-requests.js";
import type {
  LocalDirectory,
  LocalIdentity,
} from "@opensesame/app-core/lib/local-directory.js";
import { gateAccessApprovalDecision } from "@opensesame/app-core/sections/access/duress-approval-bridge.js";
import { loadEnrollmentStateForUnlock } from "@opensesame/app-core/sections/settings/security/duress-unlock-bridge.js";
import { useId, useState } from "react";

function listRequestApprovers(
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

function approvalDuressArmed(): boolean {
  const state = loadEnrollmentStateForUnlock();
  return Boolean(
    state?.armed &&
      state.triggers.some((t) => t.slot.profileId === "approval-duress"),
  );
}

type AccessRequestRun = (
  action: () => Promise<LocalAccessRequest> | Promise<void>,
  success: string,
) => Promise<boolean>;

type DecideAccessRequestInput = Readonly<{
  tomb: string;
  row: LocalAccessRequest;
  principalId: string;
  decision: "approve" | "deny";
  approvalCode: string;
  run: AccessRequestRun;
}>;

async function decideAccessRequestWithDuressGate(
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
  run: AccessRequestRun;
  close: () => void;
}) {
  const id = useId();
  const approvers = listRequestApprovers(directory, row);
  const [principalId, setPrincipalId] = useState(approvers[0]?.id ?? "");
  const [approvalCode, setApprovalCode] = useState("");
  const showCode = approvalDuressArmed();

  async function decide(decision: "approve" | "deny") {
    const ok = await decideAccessRequestWithDuressGate({
      tomb,
      row,
      principalId,
      decision,
      approvalCode,
      run,
    });
    if (ok) close();
  }

  if (row.status !== "pending") return null;

  return (
    <>
      {showCode ? (
        <div className="field">
          <label className="label" htmlFor={`${id}-code`}>
            Code
          </label>
          <input
            id={`${id}-code`}
            type="password"
            autoComplete="one-time-code"
            value={approvalCode}
            onChange={(event) => setApprovalCode(event.target.value)}
          />
        </div>
      ) : null}
      <div className="field">
        <label className="label" htmlFor={`${id}-approver`}>
          Approving person
        </label>
        <select
          id={`${id}-approver`}
          value={principalId}
          onChange={(event) => setPrincipalId(event.target.value)}
        >
          <option value="">Choose an authorized person</option>
          {approvers.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name} · {person.id}
            </option>
          ))}
        </select>
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!principalId}
          onClick={() => void decide("approve")}
        >
          Approve with passkey
        </button>
        <button
          type="button"
          className="btn"
          disabled={!principalId}
          onClick={() => void decide("deny")}
        >
          Deny with passkey
        </button>
      </div>
    </>
  );
}
