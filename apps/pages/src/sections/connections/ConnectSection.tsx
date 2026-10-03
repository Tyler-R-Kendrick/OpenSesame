import { connectFormDraws } from "@opensesame/app-core/lib/connect-roads.js";
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import type { ReactNode, Ref } from "react";
import { useConnectorRoads } from "../../bindings/connector-roads.js";
import { AwsKmsConnectPanel } from "./AwsKmsConnectPanel.js";
import { ConnectForm } from "./ConnectForm.js";
import { GcpKmsConnectPanel } from "./GcpKmsConnectPanel.js";

type Sealed = (onFlash: (flash: Flash) => void) => ReactNode;

/** The panels that seal a device configuration in the unlocked vault. */
const SEALED_PANELS = {
  "aws-kms": (onFlash: (flash: Flash) => void) => (
    <AwsKmsConnectPanel onFlash={onFlash} />
  ),
  "gcp-kms": (onFlash: (flash: Flash) => void) => (
    <GcpKmsConnectPanel onFlash={onFlash} />
  ),
};

function sealedPanel(id: string): Sealed | undefined {
  switch (id) {
    case "aws-kms":
    case "gcp-kms":
      return SEALED_PANELS[id];
    default:
      return undefined;
  }
}

/**
 * A connector page's Connect panel. It is drawn only when it has something to
 * act on: a vault-sealed panel for an unlocked vault, or the form whose road
 * is open on this device. A panel with no control in it is not a panel
 * (ADR 0158).
 */
export function ConnectSection({
  provider,
  online,
  canConfigure,
  configureHint,
  authorizeRef,
  onFlash,
  onChanged,
  onRememberOffer,
}: {
  provider: Provider;
  online: boolean;
  canConfigure: boolean;
  configureHint: string;
  authorizeRef: Ref<HTMLElement>;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
  onRememberOffer: (connection: Connection) => void;
}) {
  const roads = useConnectorRoads();
  const sealed = sealedPanel(provider.id);
  let body: ReactNode = null;
  if (sealed) {
    body = roads.acts(provider) ? sealed(onFlash) : null;
  } else if (!canConfigure) {
    body = (
      <div className="panel__body">
        <p className="hint">{configureHint}</p>
      </div>
    );
  } else if (connectFormDraws(provider)) {
    body = (
      <ConnectForm
        key={provider.id}
        provider={provider}
        online={online}
        onFlash={onFlash}
        onConnected={onChanged}
        onRememberOffer={onRememberOffer}
      />
    );
  }
  if (body === null) return null;
  return (
    <section className="panel" id="authorization" ref={authorizeRef}>
      <div className="panel__head">
        <h2>Connect</h2>
      </div>
      {body}
    </section>
  );
}
