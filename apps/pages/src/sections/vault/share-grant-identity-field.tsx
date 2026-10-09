import type { ShareKind } from "@opensesame/app-core/lib/local-share-grants.js";
import { ShareGrantKindFields } from "./share-grant-kind-fields.js";
import { ShareGrantSelectField } from "./share-grant-select-field.js";

export function ShareGrantIdentityField({
  identities,
  busy,
  principalId,
  onPrincipal,
}: {
  identities: { id: string; name: string }[];
  busy: boolean;
  principalId: string;
  onPrincipal: (id: string) => void;
}) {
  return (
    <ShareGrantSelectField
      id="share-identity"
      label="Identity"
      required
      busy={busy}
      value={principalId}
      onChange={onPrincipal}
      options={identities.map((entry) => ({
        id: entry.id,
        label: entry.name,
      }))}
    />
  );
}

export function ShareGrantResourceFields({
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
  return (
    <ShareGrantKindFields
      busy={busy}
      kind={kind}
      resources={resources}
      resourceId={resourceId}
      policy={policy}
      duration={duration}
      onKind={onKind}
      onResource={onResource}
      onPolicy={onPolicy}
      onDuration={onDuration}
    />
  );
}
