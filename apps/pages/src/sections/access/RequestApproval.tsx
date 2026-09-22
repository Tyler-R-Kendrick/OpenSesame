import { useId, useState } from "react";
import {
  type LocalAccessRequest,
  decideLocalAccessRequest,
  localRequestMemberMayDecide,
} from "../../lib/local-access-requests.js";
import type { LocalDirectory } from "../../lib/local-directory.js";
import { loadEnrollmentStateForUnlock } from "../settings/security/duress-unlock-bridge.js";
import { gateAccessApprovalDecision } from "./duress-approval-bridge.js";

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
    const gate = await gateAccessApprovalDecision({
      decision,
      code: approvalCode,
    });
    if (
      gate.kind === "need_code" ||
      gate.kind === "deny" ||
      gate.kind === "duress"
    ) {
      return;
    }
    if (
      await run(
        () => decideLocalAccessRequest(tomb, { ...row, principalId, decision }),
        decision === "approve"
          ? "Request approved; awaiting single-use consumption by its requester."
          : "Request denied.",
      )
    ) {
      close();
    }
  }

  if (row.status !== "pending") return null;

  return (
    <>
      {approvalDuressArmed ? (
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
