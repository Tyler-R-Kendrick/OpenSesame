import type { ShareKind } from "@opensesame/app-core/lib/local-share-grants.js";
import {
  ShareGrantIdentityField,
  ShareGrantResourceFields,
} from "./share-grant-identity-field.js";

export function ShareGrantFields({
  identities,
  busy,
  kind,
  resources,
  principalId,
  resourceId,
  policy,
  duration,
  onKind,
  onPrincipal,
  onResource,
  onPolicy,
  onDuration,
}: {
  identities: { id: string; name: string }[];
  busy: boolean;
  kind: ShareKind;
  resources: { id: string; label: string }[];
  principalId: string;
  resourceId: string;
  policy: string;
  duration: number;
  onKind: (kind: ShareKind) => void;
  onPrincipal: (id: string) => void;
  onResource: (id: string) => void;
  onPolicy: (id: string) => void;
  onDuration: (seconds: number) => void;
}) {
  return (
    <>
      <ShareGrantIdentityField
        identities={identities}
        busy={busy}
        principalId={principalId}
        onPrincipal={onPrincipal}
      />
      <ShareGrantResourceFields
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
    </>
  );
}
