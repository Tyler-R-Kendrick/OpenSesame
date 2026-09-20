import { useState } from "react";
import {
  ConnectionCeremony,
  connectorGlyph,
} from "../../components/ConnectivityBar.js";
import { StatusMark } from "../../components/StatusMark.js";
import type { ConnectorId, ConnectorTone } from "../../lib/connectors.js";
import {
  isOfflineSet,
  needsAttention,
  useConnectors,
} from "../../lib/connectors.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";

export const coreConnectionsDependencies = {
  useConnectors,
  connectorGlyph,
  ConnectionCeremony,
};

function markTone(tone: ConnectorTone): "ok" | "warn" | "idle" {
  if (tone === "live") return "ok";
  if (tone === "off") return "idle";
  return "warn";
}

/** Planes the bar shows, as the same tiles as the rest of Connections. */
export function CoreConnectionsPanel() {
  const connectors = coreConnectionsDependencies.useConnectors();
  const [open, setOpen] = useState<ConnectorId | null>(null);
  const panelRef = useGuideTarget<HTMLElement>("settings.core-connections");
  const attention = needsAttention(connectors);
  const unconnected = connectors.filter((c) => c.tone !== "live").length;
  const offline = isOfflineSet(connectors);

  return (
    <div className="conn-group" id="core-connections" ref={panelRef}>
      <h3 className="conn-group__label">
        Core
        <StatusMark
          tone={offline || attention ? "warn" : "ok"}
          label={
            offline
              ? "Offline"
              : attention > 0
                ? `${attention} ${attention === 1 ? "needs" : "need"} attention`
                : unconnected === 0
                  ? "All connected"
                  : "Nothing needs setup"
          }
        />
      </h3>
      <ul className="conn-grid">
        {connectors.map((connector) => (
          <li className="conn-tile" key={connector.id}>
            <button
              type="button"
              className="conn-tile__link"
              aria-label={connector.name}
              title={connector.detail}
              onClick={() => setOpen(connector.id)}
            >
              <span className="conn__mark" aria-hidden="true">
                {coreConnectionsDependencies.connectorGlyph(connector.id, 20)}
              </span>
              <span className="conn-tile__name">{connector.name}</span>
              <StatusMark
                tone={markTone(connector.tone)}
                label={connector.detail}
              />
            </button>
          </li>
        ))}
      </ul>
      {open ? (
        <coreConnectionsDependencies.ConnectionCeremony
          id={open}
          connectors={connectors}
          onClose={() => setOpen(null)}
          onSwitch={(next) => setOpen(next)}
        />
      ) : null}
    </div>
  );
}
