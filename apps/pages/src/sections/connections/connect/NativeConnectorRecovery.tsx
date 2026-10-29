import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { errorText } from "@opensesame/app-core/sections/connections/shared.js";
import { useEffect, useState } from "react";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconRefresh } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { nativeError, nativePublicUrl } from "./native-connector-ui-values.js";
import type {
  NativeConnectorCallbacks,
  NativeConnectorController,
  NativeRevocationGuide,
} from "./native-connector-ui.js";

function useNativeRevocationGuide(
  controller: NativeConnectorController,
  entryId: string,
  revision: number,
  attempt: number,
) {
  const [acknowledged, setAcknowledged] = useState(false);
  const synchronous = controller.revocationInstructions?.(entryId);
  const synchronousAvailable = !!synchronous;
  const [loaded, setLoaded] = useState<{
    revision: number;
    attempt: number;
    retry: number;
    guide: NativeRevocationGuide | null;
  } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setAcknowledged(false);
    setLoaded(null);
    setLoadError(false);
    if (synchronousAvailable || !controller.loadRevocationInstructions) return;
    let current = true;
    Promise.resolve()
      .then(() =>
        current
          ? (controller.loadRevocationInstructions?.(entryId) ?? null)
          : null,
      )
      .then((guide) => {
        if (current) setLoaded({ revision, attempt, retry, guide });
      })
      .catch(() => {
        if (current) setLoadError(true);
      });
    return () => {
      current = false;
    };
  }, [controller, entryId, revision, attempt, retry, synchronousAvailable]);
  const instructions =
    synchronous ??
    (loaded?.revision === revision &&
    loaded.attempt === attempt &&
    loaded.retry === retry
      ? loaded.guide
      : null);
  return {
    acknowledged,
    setAcknowledged,
    instructions,
    loadError,
    retryGuide: () => setRetry((value) => value + 1),
  };
}

function NativeRevocationConfirmation({
  entry,
  controller,
  disabled,
  onConfirm,
  revision,
  attempt,
}: {
  entry: NativeConnectorView["recovery"][number];
  controller: NativeConnectorController;
  disabled: boolean;
  onConfirm: (id: string, guideRevision?: number) => void;
  revision: number;
  attempt: number;
}) {
  const { acknowledged, setAcknowledged, instructions, loadError, retryGuide } =
    useNativeRevocationGuide(controller, entry.id, revision, attempt);
  if (!instructions && loadError)
    return (
      <div>
        <StatusMark
          tone="warn"
          label="Provider revocation guide is unavailable. Try again after the authorization operation finishes."
        />
        <button type="button" disabled={disabled} onClick={retryGuide}>
          Retry provider revocation guide
        </button>
      </div>
    );
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
        <span>
          {instructions.acknowledgementLabel ??
            "I revoked this application at the provider"}
        </span>
      </label>
      <FormCommit
        label="Confirm provider revocation"
        disabled={
          !acknowledged ||
          !instructions.canConfirm ||
          !controller.confirmRevocation
        }
        onClick={() => onConfirm(entry.id, instructions.revision)}
      />
      {!instructions.canConfirm ? (
        <StatusMark
          tone="warn"
          label="This provider authorization requires recovery before confirmation. Review the guide and retry cleanup."
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
  const [attempt, setAttempt] = useState(0);
  async function recover(id: string, confirm = false, guideRevision?: number) {
    if (busy || disabled) return;
    setBusy(true);
    setFailure("");
    try {
      if (confirm) {
        if (!controller.confirmRevocation) return;
        const synchronous = controller.revocationInstructions?.(id);
        if (synchronous && !synchronous.canConfirm) return;
        if (guideRevision === undefined && !synchronous?.canConfirm) return;
        if (guideRevision === undefined) await controller.confirmRevocation(id);
        else await controller.confirmRevocation(id, guideRevision);
      } else await controller.retry(id);
    } catch (error) {
      if (confirm) setAttempt((value) => value + 1);
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
            revision={view.revision}
            attempt={attempt}
            onConfirm={(id, guideRevision) =>
              void recover(id, true, guideRevision)
            }
          />
        </div>
      ))}
      {failure ? <StatusMark tone="err" label={failure} /> : null}
    </section>
  );
}
