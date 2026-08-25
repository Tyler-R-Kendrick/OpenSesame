import { useState } from "react";

import type { ConnectorStatus } from "../lib/connectors.js";
import { hostBase, hostRoutedViaDaemon } from "../lib/identity.js";
import { loadSettings, saveSettings, shippedHostApi } from "../lib/settings.js";
import { isLoopbackUrl } from "../lib/urls.js";
import { type CeremonyAlt, CeremonyShell } from "./CeremonyShell.js";
import { FieldShell } from "./FieldShell.js";
import { IconAuthority, IconExternal, IconTerminal } from "./Icons.js";
import { QrCode } from "./QrCode.js";
import { StatusNote } from "./StatusNote.js";

export const hostCeremonyDependencies = {
  hostBase,
  hostRoutedViaDaemon,
  loadSettings,
  saveSettings,
  shippedHostApi,
};

const TRAILING_SLASH = /\/$/;

/**
 * The Host ceremony.
 *
 * This is the one the first implementation left empty: a status line, an
 * `actions` div with nothing in it, and a sentence telling you to go and open
 * Settings. Four interactions and a route change to reach a text box, from a
 * sheet whose entire premise is that repairing a connection should put you back
 * where you were.
 *
 * So the two things that actually change a Host — re-probing it, and pointing
 * at a different one — happen here. Nothing in this sheet navigates.
 */
export function HostCeremony({
  connector,
  onCheckNow,
  onSwitch,
}: {
  connector: ConnectorStatus;
  onCheckNow: () => void;
  /** Move to another connector's ceremony without leaving the sheet. */
  onSwitch: (id: "machine") => void;
}) {
  const settings = hostCeremonyDependencies.loadSettings();
  const base = hostCeremonyDependencies.hostBase();
  const daemon = settings.daemonApi.trim();
  const viaDaemon = Boolean(
    daemon && hostCeremonyDependencies.hostRoutedViaDaemon(base, daemon),
  );
  const live = connector.tone === "live";

  const alts: CeremonyAlt[] = [
    {
      id: "elsewhere",
      label: "Point at a host someone else runs",
      icon: <IconExternal size={18} />,
      render: () => <HostAddress />,
    },
    {
      id: "qr",
      label: "Show pairing QR",
      icon: <IconTerminal size={18} />,
      render: () => <PairingQr daemonApi={daemon} onSwitch={onSwitch} />,
    },
  ];

  return (
    <CeremonyShell
      ok={live}
      top={live ? "Reachable" : "Not answering"}
      name={base ? base : "No host configured"}
      facts={[
        {
          key: "Round trip",
          // Only a successful probe has a duration worth showing; a failure's
          // elapsed time is just the timeout we chose.
          value: connector.rttMs === null ? "—" : `${connector.rttMs} ms`,
        },
        {
          key: "Route",
          value: viaDaemon ? "via this machine's daemon" : "direct",
        },
      ]}
      primary={{
        label: connector.checking ? "Probing…" : "Re-probe",
        onClick: onCheckNow,
        busy: connector.checking,
      }}
      alts={alts}
    />
  );
}

/** The endpoint field, in the sheet, committing on blur like the panel does. */
function HostAddress() {
  const [value, setValue] = useState(
    () => hostCeremonyDependencies.loadSettings().hostApi,
  );
  const [saved, setSaved] = useState(false);
  const shipped = hostCeremonyDependencies.shippedHostApi;

  function commit(raw: string) {
    const next = raw.trim().replace(TRAILING_SLASH, "");
    const current = hostCeremonyDependencies.loadSettings();
    if (current.hostApi === next) return;
    hostCeremonyDependencies.saveSettings({ ...current, hostApi: next });
    setSaved(true);
  }

  return (
    <FieldShell
      id="ceremony-host-api"
      label="Host API"
      type="url"
      mono
      lead={<IconAuthority size={17} />}
      placeholder={shipped}
      value={value}
      onValueChange={setValue}
      onCommit={commit}
      status={saved ? <span className="chip chip--ok">Saved</span> : null}
      // Only offer a default that is not already in the box: a fill chip that
      // does nothing is a button that teaches you not to trust buttons.
      fills={
        value.trim() === shipped
          ? []
          : [{ label: shipped, onPick: () => setValue(shipped) }]
      }
      hint="Saves when you leave the field. The connectivity bar re-probes straight away."
    />
  );
}

/**
 * The pairing hand-off, for a second device.
 *
 * A loopback daemon address is useless in a QR — the phone that scans it would
 * resolve 127.0.0.1 to itself — so when there is nothing shareable this offers
 * the machine ceremony instead of a dead square. That switch stays inside the
 * sheet; it is a different step of the same repair, not a trip to Settings.
 */
function PairingQr({
  daemonApi,
  onSwitch,
}: {
  daemonApi: string;
  onSwitch: (id: "machine") => void;
}) {
  const shareable = daemonApi && !isLoopbackUrl(daemonApi);
  if (!shareable) {
    return (
      <>
        <StatusNote
          message={{
            tone: "warn",
            text: "There is no shareable address yet — this machine is reachable only from itself.",
          }}
        />
        <div className="actions">
          <button
            type="button"
            className="btn"
            onClick={() => onSwitch("machine")}
          >
            Pair this machine first
          </button>
        </div>
      </>
    );
  }
  return (
    <div className="qr-block">
      <QrCode
        value={daemonApi}
        size={144}
        label={`Pairing QR for ${daemonApi}`}
      />
      <p className="hint">
        Scan on another device to open <code>{daemonApi}</code>. It pairs
        against the same daemon, so it gets this Host with it.
      </p>
    </div>
  );
}
