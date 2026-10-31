import { isAiConnectionProvider } from "@opensesame/app-core/lib/ai-connections/presets.js";
import { connectSubjectId } from "@opensesame/app-core/lib/connect-draft.js";
import {
  type ConnectPlan,
  connectPlan,
} from "@opensesame/app-core/lib/connect-plan.js";
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { isNativeDeviceConnection } from "@opensesame/app-core/lib/device-connector-view.js";
import { isSelfHostedConnector } from "@opensesame/app-core/lib/self-hosted-connectors.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useState } from "react";
import { useIdentitySession } from "../../../bindings/identity.js";
import { useVault } from "../../../lib/vault/hooks.js";
import { AiConnectionPanels } from "../ai/AiConnectionPanels.js";
import {
  IdentityConnectionPanels,
  isIdentityConnectionProvider,
} from "../identity/IdentityConnectionPanels.js";
import { TailscalePanels } from "../tailscale/TailscalePanels.js";
import { ConnectTransportPanel } from "./ConnectTransportPanel.js";
import { ConnectorPanel } from "./ConnectorPanel.js";
import { ConnectorSettingsForm } from "./ConnectorSettingsForm.js";
import { LinearConnectorForm } from "./LinearConnectorForm.js";
import { LinearConnectorSummary } from "./LinearConnectorSummary.js";
import { NativeConnectorPanels } from "./NativeConnectorPanels.js";
import { UserTokenPanel } from "./UserTokenPanel.js";
import { useConnectTransport } from "./useConnectTransport.js";
import { useNativeAuthorization } from "./useNativeAuthorization.js";
import "./connect.css";

/** A connection that lives on Vercel Connect, not the Host or the device. */
export function isConnectConnection(connection: Connection | null): boolean {
  return connection?.connectionRef.startsWith("connect://") === true;
}

type Props = {
  provider: Provider;
  connection: Connection | null;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
};

function ImportedConnectPanels({
  provider,
  connection,
  online,
  onFlash,
}: Props & { connection: Connection }) {
  const plan = connectPlan(provider.id);
  const transport = useConnectTransport();
  const session = useIdentitySession();
  const vault = useVault();
  const { tomb } = vault;
  // A recreated vault with the same display name has a new header; bind the
  // signed-out Connect subject to that instance, not the name alone.
  const vaultInstance =
    vault.header?.protection?.vaultId ?? vault.header?.createdAt ?? null;
  if (!plan) return null;
  return (
    <div className="cx-setup">
      <ConnectTransportPanel
        relay={transport.relay}
        showForm={!transport.canManage}
        held={transport.held}
        onFlash={onFlash}
      />
      <section className="panel" id="connector" aria-label="Connector">
        <div className="panel__head">
          <h2>Connector settings</h2>
        </div>
        <ConnectorSettingsForm
          key={connection.connectionId}
          plan={plan}
          connectorId={connection.connectionId}
          canManage={transport.canManage}
          online={online}
          onFlash={onFlash}
        />
      </section>
      <UserTokenPanel
        key={connection.connectionId}
        connectorId={connection.connectionId}
        subjectId={connectSubjectId(
          session?.principalId,
          tomb,
          undefined,
          vaultInstance,
        )}
        scopes={connection.grantedScopes}
        canManage={transport.canManage}
        canProve={transport.canProve}
        online={online}
        onFlash={onFlash}
      />
    </div>
  );
}

/** New provider configuration is local; imported hosted connections retain their ceremony. */
export function ConnectPanels(props: Props) {
  const { provider, connection } = props;
  const plan = connectPlan(provider.id);
  if (plan && !plan.refused && connection && isConnectConnection(connection))
    return <ImportedConnectPanels {...props} connection={connection} />;
  return <LocalConnectPanels {...props} />;
}

function LocalConnectPanels(props: Props) {
  const { provider, connection, onFlash, onChanged } = props;
  const plan = connectPlan(provider.id);
  if (provider.id === "tailscale") return <TailscalePanels {...props} />;
  if (isAiConnectionProvider(provider.id))
    return (
      <AiConnectionPanels
        providerId={provider.id}
        connectionId={connection?.connectionId}
        onFlash={onFlash}
        onChanged={onChanged}
      />
    );
  if (isIdentityConnectionProvider(provider.id))
    return (
      <IdentityConnectionPanels
        key={`${provider.id}/${connection?.connectionId ?? "new"}`}
        {...props}
      />
    );
  if (!plan || plan.refused) return null;
  if (provider.id !== "linear") return <NativeConnectorPanels {...props} />;
  return <LinearPanels {...props} plan={plan} />;
}

type LinearProps = Props & { plan: ConnectPlan };
type LinearAuthorization = ReturnType<typeof useNativeAuthorization>;

/** One UI owner survives the new configuration becoming the selected saved row. */
function LinearPanels(props: LinearProps) {
  const pending = useNativeAuthorization(
    props.plan.id,
    props.connection?.connectionId,
  );
  const local =
    props.connection &&
    isSelfHostedConnector(props.connection) &&
    !isNativeDeviceConnection(props.connection);
  return local ? (
    <LinearLocalPanelBody {...props} pending={pending} />
  ) : (
    <LinearMcpPanels {...props} pending={pending} />
  );
}

/** Linear's default road is Linear's MCP authorization; GraphQL is an explicit fallback. */
function LinearMcpPanels({
  plan,
  pending,
  ...props
}: LinearProps & {
  pending: LinearAuthorization;
}) {
  const [advanced, setAdvanced] = useState(false);
  const { connection, onFlash, onChanged } = props;
  return (
    <NativeConnectorPanels
      {...props}
      renderConfiguration={(form) => (
        <>
          {form}
          {connection ? null : (
            <details
              className="cx-application"
              onToggle={(event) => setAdvanced(event.currentTarget.open)}
            >
              <summary>Advanced: existing OAuth app or API key</summary>
              {advanced ? (
                <div className="cx-form">
                  <p className="hint">
                    Linear MCP authorization is the default and does not need a
                    registered OAuth application. Use this separate GraphQL
                    connection only when your workspace requires the specialized
                    API route; its credential is never shared with the MCP
                    connection.
                  </p>
                  <LinearConnectorForm
                    plan={plan}
                    onFlash={onFlash}
                    onSaved={onChanged}
                    onAuthorization={pending.onAuthorization}
                    authorization={pending.authorization}
                    captureUiCurrent={pending.captureUiCurrent}
                  />
                </div>
              ) : null}
            </details>
          )}
        </>
      )}
    />
  );
}

export function LinearLocalPanels(props: LinearProps) {
  const pending = useNativeAuthorization(
    props.plan.id,
    props.connection?.connectionId,
  );
  return <LinearLocalPanelBody {...props} pending={pending} />;
}

function LinearLocalPanelBody({
  connection,
  plan,
  onFlash,
  onChanged,
  pending,
}: LinearProps & { pending: LinearAuthorization }) {
  const local =
    connection?.providerId === "linear" && isSelfHostedConnector(connection)
      ? connection
      : null;
  const connectorId = local?.connectionId;
  return (
    <div className="cx-setup">
      <ConnectorPanel step={2} title={local ? "Configure" : "Connect"} focus>
        <LinearConnectorForm
          key={`${plan.id}/${connectorId ?? "new"}`}
          plan={plan}
          connectorId={connectorId}
          onFlash={onFlash}
          onSaved={onChanged}
          onAuthorization={pending.onAuthorization}
          authorization={pending.authorization}
          captureUiCurrent={pending.captureUiCurrent}
        />
      </ConnectorPanel>
      {local ? (
        <fieldset className="cx-block" disabled={!!pending.authorization}>
          <legend className="visually-hidden">
            Linear saved connection actions
          </legend>
          <LinearConnectorSummary
            key={connectorId ?? "new"}
            connection={local}
            onFlash={onFlash}
            onChanged={onChanged}
            onAuthorization={pending.onAuthorization}
            captureUiCurrent={pending.captureUiCurrent}
          />
        </fieldset>
      ) : null}
    </div>
  );
}
