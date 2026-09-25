import { connectSubjectId } from "@opensesame/app-core/lib/connect-draft.js";
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useIdentitySession } from "../../../bindings/identity.js";
import { useVault } from "../../../lib/vault/hooks.js";
import { ConnectCreateForm } from "./ConnectCreateForm.js";
import { ConnectTransportPanel } from "./ConnectTransportPanel.js";
import { ConnectorAccessPanel } from "./ConnectorAccessPanel.js";
import { ConnectorSettingsForm } from "./ConnectorSettingsForm.js";
import { UserTokenPanel } from "./UserTokenPanel.js";
import { useConnectTransport } from "./useConnectTransport.js";
import "./connect.css";

/** A connection that lives on Vercel Connect, not the Host or the device. */
export function isConnectConnection(connection: Connection | null): boolean {
  return connection?.connectionRef.startsWith("connect://") === true;
}

/**
 * A connector page on Vercel Connect: never blank. Before a connector exists
 * the whole configuration is on the page, filled from the plan; once it
 * exists, its settings, a person's own token and who may use it.
 */
export function ConnectPanels({
  provider,
  connection,
  online,
  onFlash,
  onChanged,
}: {
  provider: Provider;
  connection: Connection | null;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
}) {
  const plan = connectPlan(provider.id);
  const transport = useConnectTransport();
  const session = useIdentitySession();
  const { tomb } = useVault();
  if (!plan || plan.refused) return null;
  const connected = isConnectConnection(connection) ? connection : null;
  return (
    <>
      {transport.canManage ? null : (
        <ConnectTransportPanel relay={transport.relay} onFlash={onFlash} />
      )}
      <section className="panel" id="connector" aria-label="Connector">
        <div className="panel__head">
          <h2>{connected ? "Connector settings" : "Create connector"}</h2>
        </div>
        {connected ? (
          <ConnectorSettingsForm
            key={connected.connectionId}
            plan={plan}
            connectorId={connected.connectionId}
            canManage={transport.canManage}
            online={online}
            onFlash={onFlash}
          />
        ) : (
          <ConnectCreateForm
            key={plan.id}
            plan={plan}
            canManage={transport.canManage}
            online={online}
            onFlash={onFlash}
            onCreated={onChanged}
          />
        )}
      </section>
      {connected ? (
        <UserTokenPanel
          connectorId={connected.connectionId}
          subjectId={connectSubjectId(session?.principalId, tomb)}
          scopes={connected.grantedScopes}
          canManage={transport.canManage}
          canProve={transport.canProve}
          online={online}
          onFlash={onFlash}
        />
      ) : null}
      <ConnectorAccessPanel
        providerId={provider.id}
        label={provider.displayName}
      />
    </>
  );
}
