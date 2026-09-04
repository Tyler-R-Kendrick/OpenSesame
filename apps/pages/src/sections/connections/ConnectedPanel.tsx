import { useState } from "react";
import { Link } from "react-router";
import { IconSettings } from "../../components/Icons.js";
import { NoHostNote } from "../../components/NoHostNote.js";
import type { Connection, Provider } from "../../lib/connections.js";
import { createConnection, revokeConnection } from "../../lib/connections.js";
import { canConfigureAutomatically } from "../../lib/connector-guidance.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { ConnectorMark } from "./ConnectorMark.js";
import {
  type Flash,
  STATUS_CHIP,
  connectorPath,
  errorText,
  statusSentence,
} from "./shared.js";

/** Everything currently enabled on this Host: managed authorizations plus
 *  the local storage providers that only need a switch. */
export function ConnectedPanel({
  connections,
  providers,
  loading,
  online,
  onFlash,
  onChanged,
  onRememberOffer,
  setupRequired,
  hostConfigured,
}: {
  connections: Connection[] | null;
  providers: Provider[];
  loading: boolean;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
  onRememberOffer: (offer: {
    provider: Provider;
    connection: Connection;
  }) => void;
  setupRequired: boolean;
  /**
   * Whether a Host is configured at all. Without one nothing is ever asked,
   * so "could not be read" was a report of a failure that never happened
   * (ADR 0090) — the panel says what a Host would hold instead.
   */
  hostConfigured: boolean;
}) {
  const panelRef = useGuideTarget<HTMLElement>("connections.connected");
  const live = (connections ?? []).filter((c) => c.status !== "revoked");
  const automatic = providers.filter(canConfigureAutomatically);
  const automaticIds = new Set(automatic.map((provider) => provider.id));
  const managed = live.filter(
    (connection) => !automaticIds.has(connection.providerId),
  );

  return (
    <section className="panel" ref={panelRef}>
      <div className="panel__head">
        <h2>Connected</h2>
      </div>
      <div className="panel__body panel__body--tight">
        {!hostConfigured ? (
          <NoHostNote what="A connection is a credential a Host holds for you, so an agent can be sent through it without ever seeing it." />
        ) : setupRequired ? (
          <div className="empty conn-gate">
            <h3>Choose an organization</h3>
          </div>
        ) : connections === null ? (
          <div className="conn-pad">
            <p className="hint">
              {loading
                ? "Reading connections…"
                : "Connections could not be read."}
            </p>
          </div>
        ) : automatic.length === 0 && managed.length === 0 ? (
          <div className="empty">
            <h3>Nothing connected</h3>
          </div>
        ) : (
          <ul className="conn-list">
            {automatic.map((provider) => (
              <AutomaticService
                key={provider.id}
                provider={provider}
                connection={
                  live.find(
                    (connection) => connection.providerId === provider.id,
                  ) ?? null
                }
                online={online}
                onFlash={onFlash}
                onChanged={onChanged}
                onRememberOffer={onRememberOffer}
              />
            ))}
            {managed.map((connection) => (
              <AuthorizedConnection
                key={connection.connectionId}
                connection={connection}
                provider={
                  providers.find((p) => p.id === connection.providerId) ?? null
                }
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function AuthorizedConnection({
  connection,
  provider,
}: {
  connection: Connection;
  provider: Provider | null;
}) {
  const chip = STATUS_CHIP[connection.status];
  return (
    <li className="conn-service">
      <ConnectorMark
        providerId={connection.providerId}
        displayName={connection.displayName}
      />
      <div className="conn-service__copy">
        <h3>{connection.displayName}</h3>
        <p>{statusSentence(connection, provider)}</p>
      </div>
      <div className="conn-service__actions">
        <span className={`chip ${chip.tone}`}>{chip.label}</span>
        <Link
          className="btn btn--sm"
          to={connectorPath(connection.providerId, connection.connectionId)}
          aria-label={`Settings for ${connection.displayName}`}
        >
          <IconSettings size={16} /> Settings
        </Link>
      </div>
    </li>
  );
}

export function AutomaticService({
  provider,
  connection,
  online,
  onFlash,
  onChanged,
  onRememberOffer,
  settings = true,
}: {
  provider: Provider;
  connection: Connection | null;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
  onRememberOffer?: (offer: {
    provider: Provider;
    connection: Connection;
  }) => void;
  settings?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const enabled = connection !== null;

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      if (next) {
        const created = await createConnection({
          providerId: provider.id,
          displayName: provider.displayName,
        });
        onRememberOffer?.({ provider, connection: created });
      } else if (connection) {
        await revokeConnection(connection.connectionId);
      }
      onFlash({
        tone: "ok",
        text: `${provider.displayName} is ${next ? "enabled" : "disabled"}.`,
      });
      onChanged();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="conn-service">
      <ConnectorMark
        providerId={provider.id}
        displayName={provider.displayName}
      />
      <div className="conn-service__copy">
        <h3>{provider.displayName}</h3>
        <p>
          {provider.id === "sealed-local"
            ? "Encrypted local storage with a Host-generated sealing key."
            : provider.id === "plain"
              ? "Built-in local plaintext storage for non-sensitive values."
              : "Detected on this Host; no setup needed."}
        </p>
      </div>
      <div className="conn-service__actions">
        {settings ? (
          <Link
            className="btn btn--sm"
            to={connectorPath(provider.id, connection?.connectionId)}
            aria-label={`Settings for ${provider.displayName}`}
          >
            <IconSettings size={16} /> Settings
          </Link>
        ) : null}
        <label className="conn-switch">
          <span>{enabled ? "Enabled" : "Disabled"}</span>
          <input
            type="checkbox"
            role="switch"
            aria-checked={enabled}
            checked={enabled}
            disabled={busy || !online || !provider.configured}
            onChange={(event) => void toggle(event.target.checked)}
            aria-label={`${enabled ? "Disable" : "Enable"} ${provider.displayName}`}
          />
          <span className="conn-switch__track" aria-hidden="true" />
        </label>
      </div>
    </li>
  );
}
