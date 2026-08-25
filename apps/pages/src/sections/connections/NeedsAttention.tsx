import { Link } from "react-router";
import type { Connection, Provider } from "../../lib/connections.js";
import {
  VERB_CHIP,
  VERB_LABEL,
  connectionVerb,
  unfinishedConnections,
} from "../../lib/identity-graph.js";
import { ConnectorMark } from "./ConnectorMark.js";
import { connectorPath, statusSentence } from "./shared.js";

/** Connections that exist but cannot be used until the user acts. */
export function NeedsAttention({
  connections,
  providers,
}: {
  connections: Connection[];
  providers: Provider[];
}) {
  const open = unfinishedConnections(connections);
  if (open.length === 0) return null;
  return (
    <section
      className="panel panel--attention"
      aria-labelledby="conn-inbox-title"
    >
      <div className="panel__head">
        <h2 id="conn-inbox-title">Needs attention</h2>
      </div>
      <ul className="conn-list">
        {open.map((connection) => {
          const provider =
            providers.find((item) => item.id === connection.providerId) ?? null;
          const verb = connectionVerb(connection.status);
          return (
            <li key={connection.connectionId} className="conn-service">
              <ConnectorMark
                providerId={connection.providerId}
                displayName={connection.displayName}
              />
              <div className="conn-service__copy">
                <h3>{connection.displayName}</h3>
                <p>{statusSentence(connection, provider)}</p>
              </div>
              <div className="conn-service__actions">
                <span className={`chip ${VERB_CHIP[verb]}`}>
                  {VERB_LABEL[verb]}
                </span>
                <Link
                  className="btn btn--sm btn--primary"
                  to={connectorPath(
                    connection.providerId,
                    connection.connectionId,
                  )}
                >
                  Fix
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
