import { useState } from "react";
import {
  type AccessRequest,
  createAccessRequest,
} from "../../lib/access-requests.js";

function useRequestForm(onCreated: (request: AccessRequest) => void) {
  const [approverRef, setApprover] = useState("");
  const [resource, setResource] = useState("");
  const [action, setAction] = useState("");
  const [reason, setReason] = useState("");
  const [ttl, setTtl] = useState("300");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    setBusy(true);
    setError("");
    try {
      const request = await createAccessRequest({
        approverRef: approverRef.trim(),
        bindingMessage: reason.trim(),
        authorizationDetails: [
          {
            type: "opensesame_access",
            actions: [action.trim()],
            identifier: resource.trim(),
          },
        ],
        ttlSeconds: Number(ttl),
      });
      onCreated(request);
    } catch {
      setError(
        "Request not sent; check the inbox address, fields and Identity connection.",
      );
    } finally {
      setBusy(false);
    }
  }
  return {
    approverRef,
    setApprover,
    resource,
    setResource,
    action,
    setAction,
    reason,
    setReason,
    ttl,
    setTtl,
    busy,
    error,
    submit,
  };
}

export function RequestForm({
  online,
  onCreated,
  onCancel,
}: {
  online: boolean;
  onCreated: (request: AccessRequest) => void;
  onCancel: () => void;
}) {
  const state = useRequestForm(onCreated);
  const { busy, error, submit } = state;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3>Request access</h3>
      <RequestFields state={state} />
      <p className="hint">
        Approval records consent for this exact action; it does not mint a Host
        grant.
      </p>
      {error ? (
        <p role="alert" className="note note--err">
          {error}
        </p>
      ) : null}
      <div className="actions">
        <button
          className="btn btn--primary"
          type="submit"
          disabled={busy || !online}
        >
          {busy ? "Sending…" : "Send request"}
        </button>
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function RequestFields({
  state,
}: { state: ReturnType<typeof useRequestForm> }) {
  const fields = [
    {
      id: "access-approver",
      label: "Approver inbox address",
      value: state.approverRef,
      set: state.setApprover,
      min: 8,
      max: 256,
    },
    {
      id: "access-resource",
      label: "Resource",
      value: state.resource,
      set: state.setResource,
      min: 1,
      max: 256,
    },
    {
      id: "access-action",
      label: "Action",
      value: state.action,
      set: state.setAction,
      min: 1,
      max: 128,
    },
    {
      id: "access-reason",
      label: "Reason",
      value: state.reason,
      set: state.setReason,
      min: 4,
      max: 120,
    },
  ];
  return (
    <>
      {fields.map((field) => (
        <div className="field" key={field.id}>
          <label className="label" htmlFor={field.id}>
            {field.label}
          </label>
          <input
            id={field.id}
            required
            minLength={field.min}
            maxLength={field.max}
            autoComplete="off"
            value={field.value}
            onChange={(event) => field.set(event.target.value)}
            disabled={state.busy}
          />
        </div>
      ))}
      <div className="field">
        <label className="label" htmlFor="access-ttl">
          Approval deadline
        </label>
        <select
          id="access-ttl"
          value={state.ttl}
          onChange={(event) => state.setTtl(event.target.value)}
          disabled={state.busy}
        >
          <option value="300">5 minutes</option>
          <option value="900">15 minutes</option>
          <option value="3600">1 hour</option>
        </select>
      </div>
    </>
  );
}
