import { useState } from "react";
import {
  ConnectionCeremony,
  connectorGlyph,
} from "../../components/ConnectivityBar.js";
import type { ConnectorId } from "../../lib/connectors.js";
import { needsAttention, useConnectors } from "../../lib/connectors.js";

/**
 * The five connections OpenSesame needs, as states rather than as a form.
 *
 * This replaces the Planes panel, which asked for three URLs and a Save button
 * to state facts the app already knew — the host it is talking to, whether the
 * daemon answers, which git remote holds encrypted history. Each tile opens the
 * same ceremony the connectivity bar opens, so there is one way to repair a
 * connection, not two.
 */
const ACTION: Record<string, string> = {
  live: "Connected",
  attn: "Fix",
  off: "Set up",
};

export function CoreConnectionsPanel() {
  const connectors = useConnectors();
  const [open, setOpen] = useState<ConnectorId | null>(null);
  const attention = needsAttention(connectors);

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
        <output className={`chip chip--${attention ? "warn" : "ok"}`}>
          {attention === 0
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
                {connectorGlyph(connector.id, 20)}
              </span>
              <span className="conn__grow">
                <span className="conn__name">
                  {connector.name}
                  <span className="conn__req">
                    {connector.required ? "Required" : "Built in"}
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
        <ConnectionCeremony
          id={open}
          connectors={connectors}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </section>
  );
}
