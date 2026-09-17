import { useState } from "react";
import { Link } from "react-router";
import { IconTrash } from "../../components/Icons.js";
import { listLocalGrants, removeLocalGrant } from "../../lib/access-book.js";
import { useHostConfigured } from "../../lib/use-configured.js";

/**
 * Grants this device holds in `access.book.v1` — independent of Host
 * delegations, so guest / no-Host still lists mint + import (ADR 0090).
 */
export function AccessBookPanel({ epoch }: { epoch: number }) {
  const hostConfigured = useHostConfigured();
  const [localEpoch, setLocalEpoch] = useState(0);
  const grants = listLocalGrants();
  // Parent remounts on bookEpoch; localEpoch refreshes after remove.
  void epoch;
  void localEpoch;

  return (
    <section className="panel" id="access-book" aria-label="Device grants">
      <div className="panel__head">
        <div>
          <h2>On this device</h2>
        </div>
      </div>
      <div className="panel__body">
        {hostConfigured ? null : (
          <p className="hint">
            No Host connected — grants on this device still add, import and
            export from{" "}
            <Link to="/settings/connectivity">Settings → Connectivity</Link>.
          </p>
        )}
        {grants.length === 0 ? (
          <p className="hint">No grants on this device yet.</p>
        ) : (
          <ul className="access-resources" aria-label="Local grants">
            {grants.map((grant) => (
              <li className="access-resource" key={grant.id}>
                <div className="access-resource__main">
                  <div className="access-resource__id">
                    <h3>{grant.title}</h3>
                    <code className="access-ref">{grant.resource}</code>
                  </div>
                  <span className="access-resource__meta">{grant.mode}</span>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove ${grant.title}`}
                    title={`Remove ${grant.title}`}
                    onClick={() => {
                      removeLocalGrant(grant.id);
                      setLocalEpoch((value) => value + 1);
                    }}
                  >
                    <IconTrash />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
