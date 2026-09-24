import {
  listLocalGrants,
  removeLocalGrant,
} from "@opensesame/app-core/lib/access-book.js";
import { useState } from "react";
import { IconTrash } from "../../components/Icons.js";

/**
 * Grants this device holds in `access.book.v1` — independent of Host
 * delegations, so guest / no-Host still lists mint + import (ADR 0090).
 * No Connectivity wall here: Host setup stays on AccessAuthority's Connect.
 *
 * These are the grants the path bar's import and export keys move, so the
 * panel is named for that ("Portable grants"), not "On this device" — the
 * identity shares below are on this device too, and "No grants on this
 * device yet" above twelve of them was untrue. Empty, it draws nothing:
 * the book fills from the path bar, where its keys are.
 */
export function AccessBookPanel({ epoch }: { epoch: number }) {
  const [localEpoch, setLocalEpoch] = useState(0);
  const grants = listLocalGrants();
  // Parent remounts on bookEpoch; localEpoch refreshes after remove.
  void epoch;
  void localEpoch;

  if (grants.length === 0) return null;
  return (
    <section className="panel" id="access-book" aria-label="Portable grants">
      <div className="panel__head">
        <div>
          <h2>Portable grants</h2>
        </div>
      </div>
      <div className="panel__body">
        <ul className="access-resources" aria-label="Portable grants">
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
      </div>
    </section>
  );
}
