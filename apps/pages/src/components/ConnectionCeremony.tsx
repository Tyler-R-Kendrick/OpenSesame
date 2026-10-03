import { checkNow } from "@opensesame/app-core/lib/connectivity-monitor.js";
import type {
  ConnectorId,
  ConnectorStatus,
} from "@opensesame/app-core/lib/connectors.js";
import {
  beginSignIn,
  defaultUpstream,
} from "@opensesame/app-core/lib/federation.js";
import { claimGuestAuth } from "@opensesame/app-core/lib/guest-auth.js";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { failureSentence } from "@opensesame/app-core/lib/probe-failure.js";
import { useModalFocus } from "../lib/modal-focus.js";
import { IconKey } from "./IconKey.js";
import { IconLogin, IconRefresh, IconVault, IconX } from "./Icons.js";
import { IdentityCeremony } from "./IdentityCeremony.js";
import { KeyVaultCeremony } from "./KeyVaultCeremony.js";
import { StatusMark } from "./StatusMark.js";

import { useConnectivityMonitor } from "../bindings/connectivity-monitor.js";
import { useConnectors } from "../bindings/connectors.js";
import { useConnect } from "../bindings/identity.js";
/**
 * The sheet every connection is repaired in, and the glyph each connector is
 * drawn as everywhere it appears.
 *
 * The glyph strip this file used to also render — one button per connector on
 * the statusline — is gone. "identity" and "key vault" beside each other in one
 * row told a glance nothing; a row that names the connection and says what it is
 * doing does. The overflow sheet on a phone and Settings › Connections on a wide
 * screen are where they live now.
 */
const GLYPHS = {
  identity: (size) => <IconLogin size={size} />,
  keys: (size) => <IconVault size={size} />,
} satisfies Record<ConnectorId, (size: number) => ReactNode>;

export const connectionCeremonyDependencies = {
  checkNow,
  useConnectivityMonitor,
  useConnectors,
  beginSignIn,
  defaultUpstream,
  claimGuestAuth,
  useConnect,
  KeyVaultCeremony,
};

/** The mark a connector is drawn as, in a sheet head or a connection row. */
export function connectorGlyph(id: ConnectorId, size = 19): ReactNode {
  return GLYPHS[id](size);
}

/**
 * The ceremony a connection row opens.
 *
 * It is a sheet rather than a route because repairing a connection is never
 * why you came — you were doing something else and the app told you the host
 * was down. Closing it puts you back where you were.
 */
export function ConnectionCeremony({
  id,
  connectors,
  onClose,
  onSwitch,
}: {
  id: ConnectorId;
  connectors: ConnectorStatus[];
  onClose: () => void;
  /** Move to another connector's ceremony without closing the sheet. */
  onSwitch: (next: ConnectorId) => void;
}) {
  const connector = connectors.find((entry) => entry.id === id);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  useModalFocus(true, sheetRef, closeRef, onClose);

  if (!connector) return null;

  return (
    <div className="sheet-layer">
      <button
        type="button"
        className="scrim"
        aria-label="Close"
        onClick={onClose}
      />
      <div
        ref={sheetRef}
        className="sheet"
        // biome-ignore lint/a11y/useSemanticElements: native <dialog open> inerts the page and paints a blank top-layer surface
        role="dialog"
        aria-label={`${connector.name} connection`}
        aria-modal="true"
      >
        <div className="sheet__head">
          <span className="sheet__mark" aria-hidden="true">
            {connectorGlyph(connector.id, 20)}
          </span>
          <div className="sheet__grow">
            <h2>{connector.name}</h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            ref={closeRef}
            onClick={onClose}
          >
            <IconX size={18} />
          </button>
        </div>
        <div className="sheet__body">
          <StatusMark
            tone={
              connector.tone === "live"
                ? "ok"
                : connector.tone === "attn"
                  ? "warn"
                  : "idle"
            }
            label={connector.detail}
          />
          {connector.failure ? (
            <p className="hint">
              {failureSentence(connector.failure, connector.name)}
            </p>
          ) : null}
          <CeremonyBody
            connector={connector}
            onClose={onClose}
            onSwitch={onSwitch}
          />
          <Freshness connector={connector} />
        </div>
      </div>
    </div>
  );
}

function CeremonyBody({
  connector,
  onClose,
  onSwitch,
}: {
  connector: ConnectorStatus;
  onClose: () => void;
  onSwitch: (next: ConnectorId) => void;
}) {
  switch (connector.id) {
    case "identity":
      return <IdentityCeremony connector={connector} onClose={onClose} />;
    default:
      return (
        <connectionCeremonyDependencies.KeyVaultCeremony onClose={onClose} />
      );
  }
}

/**
 * When this was last checked, when it will be checked next, and a way to say
 * "now". A status that will not say how old it is asks to be trusted blindly.
 */
function Freshness({ connector }: { connector: ConnectorStatus }) {
  const monitor = connectionCeremonyDependencies.useConnectivityMonitor();
  const [, tick] = useState(0);

  // A countdown that does not count down is worse than no countdown.
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  if (connector.lastCheckedAt === null && !connector.checking) return null;

  const now = Date.now();
  const age = connector.lastCheckedAt
    ? Math.max(0, Math.round((now - connector.lastCheckedAt) / 1000))
    : null;
  const due = monitor.nextCheckAt
    ? Math.max(0, Math.round((monitor.nextCheckAt - now) / 1000))
    : null;

  return (
    <div className="freshness">
      <output className="freshness__read">
        {connector.checking
          ? "Checking now…"
          : age === null
            ? ""
            : age < 2
              ? "Checked just now"
              : `Checked ${age}s ago`}
        {!connector.checking && due !== null ? ` · next in ${due}s` : ""}
        {monitor.offline ? " · paused while offline" : ""}
      </output>
      <IconKey
        label="Check now"
        small
        disabled={connector.checking || monitor.offline}
        onClick={() => connectionCeremonyDependencies.checkNow()}
      >
        <IconRefresh size={16} />
      </IconKey>
    </div>
  );
}
