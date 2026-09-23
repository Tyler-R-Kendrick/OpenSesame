import type { LocalAccessRequest } from "@opensesame/app-core/lib/local-access-requests.js";
import type { LocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import {
  type AccessRequestRun,
  approvalDuressArmed,
  decideAccessRequestWithDuressGate,
  listRequestApprovers,
} from "@opensesame/app-core/sections/access/request-approval-model.js";
import { useId, useState } from "react";

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
