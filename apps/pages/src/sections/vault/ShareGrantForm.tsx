import {
  SHARE_DURATIONS,
  SHARE_POLICIES,
  type ShareKind,
  listShareTargets,
} from "@opensesame/app-core/lib/local-share-grants.js";
import { type FormEvent, useEffect, useState } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconX } from "../../components/Icons.js";
import { ShareGrantFields } from "./ShareGrantFields.js";

type SaveInput = {
  principalId: string;
  resourceKind: ShareKind;
  resourceId: string;
  resourceLabel: string;
  policy: string;
  durationSeconds: number;
};

export function ShareGrantForm({
  identities,
  busy,
  onCancel,
  onSave,
  initialKind = "vault",
  initialResourceId,
}: {
  identities: { id: string; name: string }[];
  busy: boolean;
  /** Absent on a sheet, whose close key is the one way out (DESIGN.md). */
  onCancel?: () => void;
  onSave: (input: SaveInput) => void;
  /** The resource the sheet was opened for; the person may still change it. */
  initialKind?: ShareKind;
  initialResourceId?: string;
}) {
  const [kind, setKind] = useState<ShareKind>(initialKind);
  const resources = listShareTargets().filter((target) => target.kind === kind);
  const [principalId, setPrincipalId] = useState(identities[0]?.id ?? "");
  const [resourceId, setResourceId] = useState(
    initialResourceId ?? resources[0]?.id ?? "",
  );
  const [policy, setPolicy] = useState<string>(
    SHARE_POLICIES[kind][0]?.id ?? "open",
  );
  const [duration, setDuration] = useState<number>(SHARE_DURATIONS[0].seconds);
  useEffect(() => {
    const next = listShareTargets().filter((target) => target.kind === kind);
    setResourceId(next[0]?.id ?? "");
    setPolicy(SHARE_POLICIES[kind][0]?.id ?? "open");
  }, [kind]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const resource = resources.find((entry) => entry.id === resourceId);
    if (!principalId || !resource) return;
    onSave({
      principalId,
      resourceKind: kind,
      resourceId: resource.id,
      resourceLabel: resource.label,
      policy,
      durationSeconds: duration,
    });
  }

  return (
    <form onSubmit={submit}>
      <ShareGrantFields
        identities={identities}
        busy={busy}
        kind={kind}
        resources={resources}
        principalId={principalId}
        resourceId={resourceId}
        policy={policy}
        duration={duration}
        onKind={setKind}
        onPrincipal={setPrincipalId}
        onResource={setResourceId}
        onPolicy={setPolicy}
        onDuration={setDuration}
      />
      <FormCommit label="Grant" disabled={busy}>
        {onCancel ? (
          <button
            type="button"
            className="icon-btn"
            disabled={busy}
            aria-label="Cancel"
            title="Cancel"
            onClick={onCancel}
          >
            <IconX size={16} />
          </button>
        ) : null}
      </FormCommit>
    </form>
  );
}
