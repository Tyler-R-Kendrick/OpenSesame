/**
 * Step — connectors first. Connections arrive by reference (ADR 0115);
 * later tabs (backups) may reuse what this directory authorized.
 */

import { useState } from "react";
import { ConnectorDirectoryForm } from "../../../components/ConnectorDirectoryForm.js";
import { StatusMark } from "../../../components/StatusMark.js";
import {
  type ConnectorDirectory,
  pendingConnectorDirectory,
} from "../../../lib/connector-directory.js";
import type { DirectoryConnection } from "../../../lib/nango-directory.js";
import { useVaultStore } from "../../../lib/vault/hooks.js";
import { GuideTarget } from "../../../tutorial/registry/react.jsx";

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
          className="xcard"
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
              <StatusMark
                tone="warn"
                label={`${connection.errors} ${connection.errors === 1 ? "error" : "errors"}`}
              />
            ) : (
              <StatusMark tone="ok" label="Authorized" />
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
      <GuideTarget id="setup.connectors">
        <ConnectorDirectoryForm tomb={tomb} onSynced={setRecord} />
      </GuideTarget>

      {record && record.connections.length > 0 ? (
        <section className="setup__stack" aria-label="Synced connectors">
          <ConnectionCards connections={record.connections} />
        </section>
      ) : null}
    </>
  );
}
