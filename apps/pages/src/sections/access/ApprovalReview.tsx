import { useEffect, useRef, useState } from "react";
import {
  type AccessRequest,
  decideAccessRequest,
  getApprovalRequirement,
} from "../../lib/access-requests.js";
import { formatTime } from "./format.js";

function useApprovalReview(
  request: AccessRequest,
  onDecided: (result: AccessRequest) => void,
) {
  const [requirement, setRequirement] = useState<Awaited<
    ReturnType<typeof getApprovalRequirement>
  > | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    let live = true;
    void getApprovalRequirement(request.authReqId).then(
      (result) => {
        if (live) setRequirement(result);
      },
      () => {
        if (live)
          setError("Cannot load approval requirements; reload the inbox.");
      },
    );
    return () => {
      live = false;
      pending.current?.abort();
    };
  }, [request.authReqId]);
  async function decide(decision: "approve" | "deny") {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    try {
      const result = await decideAccessRequest(
        request,
        decision,
        code,
        controller.signal,
        requirement?.requireTransactionBoundActivation ?? false,
      );
      if (!controller.signal.aborted) onDecided(result);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Nothing was decided; reload the request.",
      );
    } finally {
      pending.current = null;
      setBusy(false);
      setCode("");
    }
  }
  return { requirement, code, setCode, busy, error, decide };
}

export function ApprovalReview({
  request,
  online,
  onDecided,
}: {
  request: AccessRequest;
  online: boolean;
  onDecided: (result: AccessRequest) => void;
}) {
  const { requirement, code, setCode, busy, error, decide } = useApprovalReview(
    request,
    onDecided,
  );
  return (
    <div className="access-run__detail">
      <dl className="kv">
        <div>
          <dt>Requester</dt>
          <dd>{request.requesterRef}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{formatTime(request.expiresAt)}</dd>
        </div>
        <div>
          <dt>Digest</dt>
          <dd>
            <code>{request.requestDigest}</code>
          </dd>
        </div>
        <div>
          <dt>Risk</dt>
          <dd>{requirement?.riskClass ?? "Checking…"}</dd>
        </div>
      </dl>
      <pre className="access-request__params">
        {JSON.stringify(request.authorizationDetails, null, 2)}
      </pre>
      {requirement?.requireTransactionBoundActivation ? (
        <p className="hint">
          Verify this exact decision in the Identity window, signed in as the
          approver with an enrolled passkey.
        </p>
      ) : null}
      {requirement?.requireComparison &&
      !requirement.requireTransactionBoundActivation ? (
        <div className="field">
          <label className="label" htmlFor="approval-comparison">
            Comparison code from requester
          </label>
          <input
            id="approval-comparison"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            disabled={busy}
          />
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="note note--err">
          {error}
        </p>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || !online || !requirement}
          onClick={() => void decide("approve")}
        >
          Approve request
        </button>
        <button
          type="button"
          className="btn btn--danger"
          disabled={busy || !online || !requirement}
          onClick={() => void decide("deny")}
        >
          Deny request
        </button>
      </div>
    </div>
  );
}
