import { useState } from "react";
import {
  ConnectionCeremony,
  connectorGlyph,
} from "../../components/ConnectivityBar.js";
import type { ConnectorId } from "../../lib/connectors.js";
import {
  isOfflineSet,
  needsAttention,
  useConnectors,
} from "../../lib/connectors.js";

export const coreConnectionsDependencies = {
  useConnectors,
  connectorGlyph,
  ConnectionCeremony,
};

/**
 * The five connections the bar shows, as states rather than as a form.
 *
 * Host, Identity, and this machine are required. Git history is optional
 * persistence; the key vault is built in. Each tile opens the same ceremony
 * the connectivity bar opens, so there is one way to repair a connection,
 * not two.
 */
const ACTION = {
  live: "Connected",
  attn: "Fix",
  off: "Set up",
  offline: "Paused",
} satisfies Record<string, string>;

export function CoreConnectionsPanel() {
  const connectors = coreConnectionsDependencies.useConnectors();
  const [open, setOpen] = useState<ConnectorId | null>(null);
  const attention = needsAttention(connectors);
  // Offline is one cause, not four broken connectors. Counting it as "3 need
  // setup" would send someone to fix endpoints that are perfectly fine.
  const offline = isOfflineSet(connectors);

  return (
    <section className="panel" id="core-connections">
      <div className="panel__head">
        <div>
          <h2>Core connections</h2>
          <p>
            The planes OpenSesame needs to authorize anything, plus the key
            vault that wraps your secrets. Each one is a ceremony, not a form —
            open it and it tells you what it found.
          </p>
        </div>
        <output
          className={`chip chip--${offline || attention ? "warn" : "ok"}`}
        >
          {offline
            ? "Offline"
            : attention === 0
              ? "All connected"
              : `${attention} ${attention === 1 ? "needs" : "need"} setup`}
        </output>
      </div>
      <div className="panel__body">
        <div className="conn-grid">
          {connectors.map((connector) => (
            <button
              key={connector.id}
              type="button"
              className={`conn conn--${connector.tone}`}
              onClick={() => setOpen(connector.id)}
            >
              <span className="conn__mark" aria-hidden="true">
                {coreConnectionsDependencies.connectorGlyph(connector.id, 20)}
              </span>
              <span className="conn__grow">
                <span className="conn__name">
                  {connector.name}
                  <span className="conn__req">
                    {connector.required
                      ? "Required"
                      : connector.id === "keys"
                        ? "Built in"
                        : "Optional"}
                  </span>
                </span>
                <span className="conn__state">{connector.detail}</span>
              </span>
              <span className="conn__act">{ACTION[connector.tone]}</span>
            </button>
          ))}
        </div>
      </div>
      {open ? (
        <coreConnectionsDependencies.ConnectionCeremony
          id={open}
          connectors={connectors}
          onClose={() => setOpen(null)}
          onSwitch={(next) => setOpen(next)}
        />
      ) : null}
    </section>
  );
}
