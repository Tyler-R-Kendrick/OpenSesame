import type { LocalIdentity } from "../../lib/local-directory.js";

export function RequestApprovalForm({
  id,
  approvalDuressArmed,
  approvalCode,
  setApprovalCode,
  principalId,
  setPrincipalId,
  approvers,
  onApprove,
  onDeny,
}: {
  id: string;
  approvalDuressArmed: boolean;
  approvalCode: string;
  setApprovalCode: (value: string) => void;
  principalId: string;
  setPrincipalId: (value: string) => void;
  approvers: readonly LocalIdentity[];
  onApprove: () => void;
  onDeny: () => void;
}) {
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
          onClick={onApprove}
        >
          Approve with passkey
        </button>
        <button
          type="button"
          className="btn"
          disabled={!principalId}
          onClick={onDeny}
        >
          Deny with passkey
        </button>
      </div>
    </>
  );
}
