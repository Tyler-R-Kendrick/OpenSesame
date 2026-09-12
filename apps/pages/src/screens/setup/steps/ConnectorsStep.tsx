/**
 * Step 2 — connectors. Which connectors are already authorized?
 *
 * The fewest touch-points a deployment can have: a Nango-compatible
 * directory already ran the OAuth round trips, so naming it once brings
 * every connection it holds across by reference (ADR 0115). Nothing is
 * re-authorized, no token reaches this page, and what comes back is sealed
 * with the vault — bound to people and agents from Access › Connectors.
 */

import { useState } from "react";
import { ConnectorDirectoryForm } from "../../../components/ConnectorDirectoryForm.js";
import {
  type ConnectorDirectory,
  pendingConnectorDirectory,
} from "../../../lib/connector-directory.js";
import type { DirectoryConnection } from "../../../lib/nango-directory.js";
import { useVaultStore } from "../../../lib/vault/hooks.js";
import { GuideTarget } from "../../../tutorial/registry/react.jsx";
import { StepHead } from "./shared.js";

function ConnectionCards({
  connections,
}: {
  connections: readonly DirectoryConnection[];
}) {
  return (
    <ul className="xcards" aria-label="Authorized connectors">
      {connections.map((connection) => (
        <li
          key={`${connection.integrationId}/${connection.connectionId}`}
          className="xcard is-on"
        >
          <span className="xcard__pick">
            <span className="xcard__name">
              {connection.displayName}
              {connection.endUser ? ` · ${connection.endUser}` : ""}
            </span>
            <span className="xcard__kind">
              {connection.integrationId} · {connection.connectionId}
            </span>
          </span>
          <span className="xcard__side">
            {connection.errors > 0 ? (
              <span className="chip chip--warn">
                {connection.errors}{" "}
                {connection.errors === 1 ? "error" : "errors"}
              </span>
            ) : (
              <span className="chip chip--ok">Authorized</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ConnectorsStep() {
  const store = useVaultStore();
  const tomb = store.isUnlocked() ? store.activeTomb() : null;
  const [record, setRecord] = useState<ConnectorDirectory | null>(
    pendingConnectorDirectory,
  );
  return (
    <>
      <StepHead title="Which connectors are already authorized?">
        Name a Nango-compatible directory — the hosted one, or one you run — and
        every connection it already holds becomes a connector here by reference.
        Tokens stay where they are; this device keeps the names and seals them
        with the vault.
      </StepHead>

      <GuideTarget id="setup.connectors">
        <ConnectorDirectoryForm tomb={tomb} onSynced={setRecord} />
      </GuideTarget>

      {record && record.connections.length > 0 ? (
        <section className="setup__stack" aria-label="Synced connectors">
          <p className="ways__head">
            Connectors
            <span className="ways__count">{record.connections.length}</span>
          </p>
          <ConnectionCards connections={record.connections} />
          <p className="hint">
            Who may use each one is decided in Access › Connectors, once the
            vault is open.
          </p>
        </section>
      ) : null}
    </>
  );
}
