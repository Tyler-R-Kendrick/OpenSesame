import {
  BYO_METHOD_LABELS,
  readByoConnection,
} from "@opensesame/app-core/lib/byo-connections.js";
import type { Connection } from "@opensesame/app-core/lib/connections.js";
import { Link } from "react-router";
import { ConnectorPanel } from "./connect/ConnectorPanel.js";

/** The connection page points at the vault item that actually holds custody. */
export function ByoConnectionPanels({
  connection,
}: {
  connection: Connection | null;
}) {
  const record = readByoConnection(connection);
  return (
    <ConnectorPanel step={2} label="Connection" title="Configure" focus>
      <div className="panel__body cx-form">
        {record ? (
          <>
            <p>
              {record.service} · {BYO_METHOD_LABELS[record.method]}
            </p>
            <p className="hint">
              The original credential is held by the vault item below. It is
              never written onto the connection record. Share or grant that item
              under the vault&apos;s own policies.
            </p>
            <Link className="btn btn--sm" to={`/vault/${record.itemId}`}>
              Open credential item
            </Link>
          </>
        ) : (
          <p className="hint">
            This connection has no stored vault item on this device.
          </p>
        )}
      </div>
    </ConnectorPanel>
  );
}
