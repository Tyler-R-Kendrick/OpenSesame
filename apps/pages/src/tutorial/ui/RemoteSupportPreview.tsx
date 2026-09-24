import {
  decideRemotePreview,
  remotePreviewSnapshot,
  subscribeRemotePreview,
} from "@opensesame/app-core/tutorial/agents/ag-ui/consent.js";
import { useEffect, useSyncExternalStore } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import { IconUpload, IconX } from "../../components/Icons.js";

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
      <FormCommit
        label="Send once"
        icon={<IconUpload size={18} />}
        onClick={() => decideRemotePreview(preview.id, true)}
      >
        <IconKey
          label="Keep on device"
          onClick={() => decideRemotePreview(preview.id, false)}
        >
          <IconX size={16} />
        </IconKey>
      </FormCommit>
    </section>
  );
}
