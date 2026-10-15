import { isAiModelProvider } from "@opensesame/app-core/lib/ai-model-provider.js";
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { isSecretBackendProvider } from "@opensesame/app-core/lib/secret-backends/presets.js";
import { isSelfHostedConnector } from "@opensesame/app-core/lib/self-hosted-connectors.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { ModelKeysPanel } from "./ai/keys/ModelKeysPanel.js";
import { ConnectPanels, isConnectConnection } from "./connect/ConnectPanels.js";
import { NativeConnectorPanels } from "./connect/NativeConnectorPanels.js";
import { IdentityConnectionPanels } from "./identity/IdentityConnectionPanels.js";
import { SecretBackendPanels } from "./secret-backends/SecretBackendPanels.js";

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
  secretBackendExperience?: boolean;
};
function NativeSettingsPanels(props: Props) {
  const { provider, connection } = props;
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
}
export function SettingsPageConnectPanels(props: Props) {
  const {
    provider,
    connection,
    nativeExperience,
    identityExperience,
    onConnect,
    deviceSeal,
  } = props;
  if (isSecretBackendProvider(provider.id) && !isConnectConnection(connection))
    return (
      <SecretBackendPanels
        key={`${provider.id}/${connection?.connectionId ?? "new"}`}
        {...props}
      />
    );
  if (identityExperience)
    return (
      <IdentityConnectionPanels
        key={`${provider.id}/${connection?.connectionId ?? "new"}`}
        {...props}
      />
    );
  if (nativeExperience) return <NativeSettingsPanels {...props} />;
  if (
    onConnect &&
    (!deviceSeal ||
      isSelfHostedConnector(connection) ||
      isConnectConnection(connection))
  )
    return <ConnectPanels {...props} />;
  return null;
}
