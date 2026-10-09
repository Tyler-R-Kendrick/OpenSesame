import { connectSubjectId } from "@opensesame/app-core/lib/connect-draft.js";
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { isSelfHostedConnector } from "@opensesame/app-core/lib/self-hosted-connectors.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useIdentitySession } from "../../../bindings/identity.js";
import { useVault } from "../../../lib/vault/hooks.js";
import { ConnectTransportPanel } from "./ConnectTransportPanel.js";
import { ConnectorSettingsForm } from "./ConnectorSettingsForm.js";
import { SavedConnectorSummary } from "./SavedConnectorSummary.js";
import { SelfHostedConnectorForm } from "./SelfHostedConnectorForm.js";
import { UserTokenPanel } from "./UserTokenPanel.js";
import { useConnectTransport } from "./useConnectTransport.js";
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
  const { tomb } = useVault();
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
        subjectId={connectSubjectId(session?.principalId, tomb)}
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
  const { provider, connection, onFlash, onChanged } = props;
  const plan = connectPlan(provider.id);
  if (!plan || plan.refused) return null;
  if (connection && isConnectConnection(connection))
    return <ImportedConnectPanels {...props} connection={connection} />;
  const local = isSelfHostedConnector(connection) ? connection : null;
  const connectorId = local?.connectionId;
  return (
    <div className="cx-setup">
      <section className="panel" id="connector" aria-label="Connector">
        <div className="panel__head">
          <h2>
            <span className="cx-step">2</span> Configure
          </h2>
        </div>
        <SelfHostedConnectorForm
          key={`${plan.id}/${connectorId ?? "new"}`}
          plan={plan}
          connectorId={connectorId}
          onFlash={onFlash}
          onSaved={onChanged}
        />
      </section>
      <SavedConnectorSummary
        key={connectorId ?? "new"}
        connection={local}
        onFlash={onFlash}
        onChanged={onChanged}
      />
    </div>
  );
}
