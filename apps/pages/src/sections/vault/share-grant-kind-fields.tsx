import {
  SHARE_DURATIONS,
  SHARE_POLICIES,
  type ShareKind,
} from "@opensesame/app-core/lib/local-share-grants.js";
import { ShareGrantSelectField } from "./share-grant-select-field.js";

export function ShareGrantKindFields({
  busy,
  kind,
  resources,
  resourceId,
  policy,
  duration,
  onKind,
  onResource,
  onPolicy,
  onDuration,
}: {
  busy: boolean;
  kind: ShareKind;
  resources: { id: string; label: string }[];
  resourceId: string;
  policy: string;
  duration: number;
  onKind: (kind: ShareKind) => void;
  onResource: (id: string) => void;
  onPolicy: (id: string) => void;
  onDuration: (seconds: number) => void;
}) {
  const resourceLabel =
    kind === "vault" ? "Vault" : kind === "item" ? "Item" : "Connector";
  return (
    <>
      <ShareGrantSelectField
        id="share-kind"
        label="Resource"
        busy={busy}
        value={kind}
        onChange={(value) => {
          // SAFETY: select options are the closed ShareKind set.
          onKind(value as ShareKind);
        }}
      >
        <option value="vault">Vault</option>
        <option value="connection">Connector</option>
        <option value="item">Item or folder</option>
      </ShareGrantSelectField>
      <ShareGrantSelectField
        id="share-resource"
        label={resourceLabel}
        required
        busy={busy}
        value={resourceId}
        onChange={onResource}
        options={resources}
      />
      <ShareGrantSelectField
        id="share-policy"
        label="Policy"
        busy={busy}
        value={policy}
        onChange={onPolicy}
        options={SHARE_POLICIES[kind]}
      />
      <ShareGrantSelectField
        id="share-duration"
        label="Duration"
        busy={busy}
        value={duration}
        onChange={(value) => onDuration(Number(value))}
        options={SHARE_DURATIONS.map((entry) => ({
          id: entry.seconds,
          label: entry.label,
        }))}
      />
    </>
  );
}
