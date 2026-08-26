import { type ReactNode, useState } from "react";

import { type ConnectorId, useConnectors } from "../lib/connectors.js";
import { ConnectionCeremony } from "./ConnectivityBar.js";

/**
 * Open a connector's ceremony from anywhere — a section note, an error panel.
 *
 * Before this, every surface that noticed a broken connection outside the
 * connectivity bar linked to Settings: a route change, a panel to find, a
 * disclosure to expand. The ceremony rule — repairing a connection puts you
 * back where you were — only holds if the ceremony is reachable from where
 * you already are. The sheet renders in a fixed layer, so it works from any
 * section without caring what is underneath.
 */
export function CeremonyLink({
  id,
  className = "btn btn--sm",
  children,
}: {
  id: ConnectorId;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<ConnectorId | null>(null);

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(id)}>
        {children}
      </button>
      {open ? (
        <OpenCeremony
          id={open}
          onClose={() => setOpen(null)}
          onSwitch={(next) => setOpen(next)}
        />
      ) : null}
    </>
  );
}

/**
 * Mounted only while the sheet is open, because `useConnectors` subscribes
 * the connectivity monitor. A closed launcher must cost nothing: sections
 * render these buttons on every visit, and a subscription per button would
 * start probing before anyone asked anything.
 */
function OpenCeremony({
  id,
  onClose,
  onSwitch,
}: {
  id: ConnectorId;
  onClose: () => void;
  onSwitch: (next: ConnectorId) => void;
}) {
  const connectors = useConnectors();
  return (
    <ConnectionCeremony
      id={id}
      connectors={connectors}
      onClose={onClose}
      onSwitch={onSwitch}
    />
  );
}
