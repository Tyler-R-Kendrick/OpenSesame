import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { errorText } from "@opensesame/app-core/sections/connections/shared.js";
import { useState } from "react";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconRefresh } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { nativeError, nativePublicUrl } from "./native-connector-ui-values.js";
import type {
  NativeConnectorCallbacks,
  NativeConnectorController,
} from "./native-connector-ui.js";

function NativeRevocationConfirmation({
  entry,
  controller,
  disabled,
  onConfirm,
}: {
  entry: NativeConnectorView["recovery"][number];
  controller: NativeConnectorController;
  disabled: boolean;
  onConfirm: (id: string) => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const instructions = controller.revocationInstructions?.(entry.id);
  if (!instructions) return null;
  const url = nativePublicUrl(instructions.url);
  if (!url) return null;
  return (
    <fieldset className="cx-block cx-form" disabled={disabled}>
      <legend>Provider revocation</legend>
      <details className="cx-application">
        <summary>Provider revocation guide</summary>
        <p>{instructions.message}</p>
      </details>
      <a href={url} target="_blank" rel="noopener noreferrer">
        Open provider revocation instructions
      </a>
      <label className="check">
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={!instructions.canConfirm || !controller.confirmRevocation}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        <span>I revoked this application at the provider</span>
      </label>
      <FormCommit
        label="Confirm provider revocation"
        disabled={
          !acknowledged ||
          !instructions.canConfirm ||
          !controller.confirmRevocation
        }
        onClick={() => onConfirm(entry.id)}
      />
      {!instructions.canConfirm ? (
        <StatusMark
          tone="warn"
          label="A provider authorization operation is still pending. Wait for it to finish, then retry cleanup."
        />
      ) : null}
    </fieldset>
  );
}

export function NativeConnectorRecovery({
  view,
  controller,
  disabled = false,
  onChanged,
  onFlash,
}: NativeConnectorCallbacks & {
  view: NativeConnectorView;
  controller: NativeConnectorController;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  async function recover(id: string, confirm = false) {
    if (busy || disabled) return;
    setBusy(true);
    setFailure("");
    try {
      if (confirm) {
        if (
          !controller.confirmRevocation ||
          !controller.revocationInstructions?.(id)?.canConfirm
        )
          return;
        await controller.confirmRevocation(id);
      } else await controller.retry(id);
    } catch (error) {
      const text = nativeError(errorText(error), {});
      setFailure(text);
      onFlash({ tone: "err", text });
    } finally {
      setBusy(false);
      onChanged(controller.load());
    }
  }
  if (view.recovery.length === 0) return null;
  return (
    <section className="cx-block cx-form" aria-label="Provider recovery">
      <h3>Provider cleanup</h3>
      {view.recovery.map((entry) => (
        <div className="cx-form" key={entry.id}>
          <p>{entry.label}</p>
          <IconKey
            label={`Retry ${entry.label.toLowerCase()}`}
            disabled={busy || disabled}
            aria-busy={busy || undefined}
            onClick={() => void recover(entry.id)}
          >
            <IconRefresh size={16} />
          </IconKey>
          <StatusMark tone="warn" label={entry.detail} />
          <NativeRevocationConfirmation
            key={`${view.revision}/${entry.id}`}
            entry={entry}
            controller={controller}
            disabled={busy || disabled}
            onConfirm={(id) => void recover(id, true)}
          />
        </div>
      ))}
      {failure ? <StatusMark tone="err" label={failure} /> : null}
    </section>
  );
}
