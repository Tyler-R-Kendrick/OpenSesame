import { useEffect, useSyncExternalStore } from "react";
import {
  decideRemotePreview,
  remotePreviewSnapshot,
  subscribeRemotePreview,
} from "../agents/ag-ui/consent.js";

export function RemoteSupportPreview({ warning }: { warning: string | null }) {
  const preview = useSyncExternalStore(
    subscribeRemotePreview,
    remotePreviewSnapshot,
    () => null,
  );
  useEffect(
    () => () => {
      if (preview) decideRemotePreview(preview.id, false);
    },
    [preview],
  );
  if (!preview)
    return warning ? (
      <p className="note note--warn support__egress">{warning}</p>
    ) : null;
  return (
    <section
      aria-label="Review remote support request"
      className="support__help"
    >
      <h3>Send this request?</h3>
      <p className="hint">
        To {preview.destination}. Review the exact payload. Redaction cannot
        recognize every secret in prose.
      </p>
      <pre className="support__text">
        {JSON.stringify(preview.payload, null, 2)}
      </pre>
      <div className="actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => decideRemotePreview(preview.id, true)}
        >
          Send once
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => decideRemotePreview(preview.id, false)}
        >
          Keep on device
        </button>
      </div>
    </section>
  );
}
