import { isAiConnectionProvider } from "@opensesame/app-core/lib/ai-connections/presets.js";
import { readAiConnection } from "@opensesame/app-core/lib/ai-connections/store.js";
import { isAiModelProvider } from "@opensesame/app-core/lib/ai-model-provider.js";
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { isNativeDeviceConnection } from "@opensesame/app-core/lib/device-connector-view.js";
import { isSecretBackendProvider } from "@opensesame/app-core/lib/secret-backends/presets.js";
import { isSelfHostedConnector } from "@opensesame/app-core/lib/self-hosted-connectors.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { GithubNativeAppPanels } from "./GithubNativeAppPanels.js";
import { BoatPanels } from "./boat/BoatPanels.js";
import { AiConnectionPanels } from "./ai/AiConnectionPanels.js";
import { ModelKeysPanel } from "./ai/keys/ModelKeysPanel.js";
import { ConnectPanels, isConnectConnection } from "./connect/ConnectPanels.js";
import {
  NativeConnectorPanels,
  nativeSettingsDescriptor,
} from "./connect/NativeConnectorPanels.js";
import { IdentityConnectionPanels } from "./identity/IdentityConnectionPanels.js";
import { SecretBackendPanels } from "./secret-backends/SecretBackendPanels.js";
import { TailscalePanels } from "./tailscale/TailscalePanels.js";

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
/** Specialized saved Linear rows retain their original header and custody ceremony. */
export function nativeSettingsPageDescriptor(
  provider: Provider,
  connection: Connection | null,
) {
  return provider.id === "linear" &&
    connection !== null &&
    isSelfHostedConnector(connection) &&
    !isNativeDeviceConnection(connection)
    ? null
    : nativeSettingsDescriptor(provider);
}

function NativeSettingsPanels(props: Props) {
  const { provider, connection } = props;
  if (provider.id === "github") return <GithubNativeAppPanels {...props} />;
  return (
    <>
      <NativeConnectorPanels key={provider.id} {...props} />
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
  const { provider, connection, nativeExperience, identityExperience } = props;
  // Boat is configured by claiming an account (auth.md), not by a key.
  if (provider.id === "boat" && !isConnectConnection(connection))
    return (
      <BoatPanels
        connection={connection}
        onFlash={props.onFlash}
        onChanged={props.onChanged}
      />
    );
  if (provider.id === "tailscale" && !isConnectConnection(connection))
    return <TailscalePanels {...props} />;
  // Linear composes default MCP and advanced GraphQL, and owns its saved routes.
  if (provider.id === "linear") return <ConnectPanels {...props} />;
  // A native connector row created before the provider gained an AI contract
  // has no AI record. Keep that row on its native page: the AI form would show
  // an empty key over sealed custody and could orphan it on save.
  const nativeAiRecord = readNativeAiRecord(connection);
  if (
    isAiConnectionProvider(provider.id) &&
    !isConnectConnection(connection) &&
    (!connection || nativeAiRecord)
  )
    return <AiSettingsPanels {...props} />;
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
  return <HostedSettingsPanels {...props} />;
}

function readNativeAiRecord(connection: Connection | null) {
  return connection && !isConnectConnection(connection)
    ? readAiConnection(connection.connectionId)
    : null;
}

function AiSettingsPanels({ provider, connection, onFlash, onChanged }: Props) {
  return (
    <AiConnectionPanels
      key={`${provider.id}/${connection?.connectionId ?? "new"}`}
      providerId={provider.id}
      connectionId={connection?.connectionId}
      onFlash={onFlash}
      onChanged={onChanged}
    />
  );
}

function HostedSettingsPanels(props: Props) {
  const { onConnect, deviceSeal, connection } = props;
  if (
    onConnect &&
    (!deviceSeal ||
      isSelfHostedConnector(connection) ||
      isConnectConnection(connection))
  )
    return <ConnectPanels {...props} />;
  return null;
}
