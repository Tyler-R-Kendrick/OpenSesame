import { useState } from "react";
import {
  type AccessRequest,
  getRequestComparison,
} from "../../lib/access-requests.js";

export function SentRequest({
  request,
  online,
  onRefresh,
}: {
  request: AccessRequest;
  online: boolean;
  onRefresh: () => void;
}) {
  const [comparison, setComparison] = useState<Awaited<
    ReturnType<typeof getRequestComparison>
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function issue() {
    setBusy(true);
    try {
      setComparison(await getRequestComparison(request.authReqId));
    } catch {
      setError(
        "Cannot issue a comparison code. It can only be issued once; a lost or expired code needs a new request.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="access-request">
      <h3>Sent request</h3>
      <p>
        {request.bindingMessage} — {request.status}
      </p>
      <p className="hint">
        Keep this request open to share its comparison code with the approver.
        Codes are not saved on this device.
      </p>
      <div className="actions">
        <button
          type="button"
          className="btn btn--sm"
          disabled={!online}
          onClick={onRefresh}
        >
          Refresh sent request
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={
            !online ||
            busy ||
            comparison !== null ||
            request.status !== "pending"
          }
          onClick={() => void issue()}
        >
          Show comparison code
        </button>
      </div>
      {comparison ? (
        <output className="note">
          <code>{comparison.value}</code> · expires{" "}
          {new Date(comparison.expiresAt).toLocaleTimeString()}
        </output>
      ) : null}
      {error ? (
        <p role="alert" className="note note--err">
          {error}
        </p>
      ) : null}
    </div>
  );
}
