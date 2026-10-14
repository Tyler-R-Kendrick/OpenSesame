import { isAiModelProvider } from "@opensesame/app-core/lib/ai-model-provider.js";
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { isSelfHostedConnector } from "@opensesame/app-core/lib/self-hosted-connectors.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { ModelKeysPanel } from "./ai/keys/ModelKeysPanel.js";
import { ConnectPanels, isConnectConnection } from "./connect/ConnectPanels.js";
import { NativeConnectorPanels } from "./connect/NativeConnectorPanels.js";
import { IdentityConnectionPanels } from "./identity/IdentityConnectionPanels.js";

type Props = {
  provider: Provider;
  connection: Connection | null;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
  identityExperience: boolean;
  nativeExperience: boolean;
  onConnect: "only" | "beside" | null;
  deviceSeal: boolean;
};
export function SettingsPageConnectPanels(props: Props) {
  const {
    provider,
    connection,
    nativeExperience,
    identityExperience,
    onConnect,
    deviceSeal,
  } = props;
  if (identityExperience)
    return (
      <IdentityConnectionPanels
        key={`${provider.id}/${connection?.connectionId ?? "new"}`}
        {...props}
      />
    );
  if (nativeExperience)
    return (
      <>
        <NativeConnectorPanels
          key={`${provider.id}/${connection?.connectionId ?? "new"}`}
          {...props}
        />
        {connection?.status === "active" && isAiModelProvider(provider) ? (
          <ModelKeysPanel
            providerId={provider.id}
            providerName={provider.displayName}
            connectionId={connection.connectionId}
          />
        ) : null}
      </>
    );
  if (
    onConnect &&
    (!deviceSeal ||
      isSelfHostedConnector(connection) ||
      isConnectConnection(connection))
  )
    return <ConnectPanels {...props} />;
  return null;
}
