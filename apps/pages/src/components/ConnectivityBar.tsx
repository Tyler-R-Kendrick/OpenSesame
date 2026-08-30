import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  checkNow,
  useConnectivityMonitor,
} from "../lib/connectivity-monitor.js";
import {
  type ConnectorId,
  type ConnectorStatus,
  isOfflineSet,
  needsAttention,
  useConnectors,
} from "../lib/connectors.js";
import { beginSignIn, defaultUpstream } from "../lib/federation.js";
import { claimGuestAuth } from "../lib/guest-auth.js";
import { useConnect } from "../lib/identity.js";
import { useModalFocus } from "../lib/modal-focus.js";
import { failureSentence } from "../lib/probe-failure.js";
import { ConnectGitHistory } from "./ConnectGitHistory.js";
import { HostCeremony } from "./HostCeremony.js";
import {
  IconAuthority,
  IconGitBranch,
  IconLogin,
  IconTerminal,
  IconVault,
  IconX,
} from "./Icons.js";
import { IdentityCeremony } from "./IdentityCeremony.js";
import { KeyVaultCeremony } from "./KeyVaultCeremony.js";
import { ConnectThisMachine } from "./PlaneNote.js";
import { StatusNote } from "./StatusNote.js";

/**
 * The connectivity bar — a phone status bar for the authorization fabric.
 *
 * Connection state is a state, not a setting, so it lives up top where a glance
 * costs nothing: five glyphs, a coloured pip under each, and an amber pip as
 * the only thing that ever pulls the eye. Clicking one that is not live opens
 * its ceremony; clicking a live one shows what it is connected to.
 */
const GLYPHS = {
  host: (size) => <IconAuthority size={size} />,
  identity: (size) => <IconLogin size={size} />,
  machine: (size) => <IconTerminal size={size} />,
  history: (size) => <IconGitBranch size={size} />,
  keys: (size) => <IconVault size={size} />,
} satisfies Record<ConnectorId, (size: number) => ReactNode>;

export const connectivityBarDependencies = {
  checkNow,
  useConnectivityMonitor,
  useConnectors,
  beginSignIn,
  defaultUpstream,
  claimGuestAuth,
  useConnect,
  ConnectGitHistory,
  ConnectThisMachine,
  HostCeremony,
  KeyVaultCeremony,
};

export function connectorGlyph(id: ConnectorId, size = 19): ReactNode {
  return GLYPHS[id](size);
}

function ConnectivityBarDefault() {
  const connectors = connectivityBarDependencies.useConnectors();
  const [open, setOpen] = useState<ConnectorId | null>(null);
  const attention = needsAttention(connectors);
  const offline = isOfflineSet(connectors);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("github_app")) setOpen("history");
  }, []);

  return (
    <>
      {/* A fieldset, as the theme switcher already does — the group role comes
          from the element rather than an attribute. */}
      <fieldset
        className="cx"
        aria-label={
          offline
            ? "Connections — offline"
            : attention === 1
              ? "Connections — 1 needs setup"
              : attention > 1
                ? `Connections — ${attention} need setup`
                : "Connections — all connected"
        }
      >
        {connectors.map((connector) => (
          <ConnectorGlyph
            key={connector.id}
            connector={connector}
            onOpen={() => {
              // Opening a ceremony is a person asking, so refresh rather than
              // showing them whatever the last sweep happened to find.
              connectivityBarDependencies.checkNow();
              setOpen(connector.id);
            }}
          />
        ))}
      </fieldset>
      {open ? (
        <ConnectionCeremony
          id={open}
          connectors={connectors}
          onClose={() => setOpen(null)}
          onSwitch={(next) => setOpen(next)}
        />
      ) : null}
    </>
  );
}

export const connectivityBarSeams = {
  ConnectivityBar: ConnectivityBarDefault,
};

export function ConnectivityBar() {
  const Impl = connectivityBarSeams.ConnectivityBar;
  return <Impl />;
}

/**
 * One glyph.
 *
 * Recovery gets a one-shot settle animation. Without it a connector that comes
 * back while you are looking elsewhere just silently is green later, and the
 * whole promise of the bar is that you do not have to keep looking.
 */
function ConnectorGlyph({
  connector,
  onOpen,
}: {
  connector: ConnectorStatus;
  onOpen: () => void;
}) {
  const previousTone = useRef(connector.tone);
  const [recovered, setRecovered] = useState(false);

  useEffect(() => {
    const was = previousTone.current;
    previousTone.current = connector.tone;
    if (connector.tone !== "live" || was === "live") return;
    setRecovered(true);
    const timer = setTimeout(() => setRecovered(false), 1400);
    return () => clearTimeout(timer);
  }, [connector.tone]);

  const label = `${connector.name} — ${connector.detail}`;
  return (
    <button
      type="button"
      className={[
        "cx__btn",
        `cx__btn--${connector.tone}`,
        connector.checking ? "is-checking" : "",
        recovered ? "is-recovered" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      // The glyph carries no text, so the whole status has to live in the
      // accessible name — a screen reader gets the same glance we do.
      aria-label={label}
      title={label}
      onClick={onOpen}
    >
      {connectorGlyph(connector.id)}
      <span className="cx__pip" aria-hidden="true" />
    </button>
  );
}

/**
 * The ceremony a glyph or a tile opens.
 *
 * It is a sheet rather than a route because repairing a connection is never
 * why you came — you were doing something else and the bar told you the host
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
            <p>{CEREMONY_LEAD[connector.id]}</p>
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
          <p className={`chip chip--${toneChip(connector.tone)}`}>
            {connector.detail}
          </p>
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
        {/* One line of standing truth per ceremony, in the footer the canvas
            draws. It is the same sentence whatever step you are on, so it can
            be read once and stop competing with the action. */}
        <div className="sheet__foot">
          <p className="hint">{CEREMONY_FOOT[connector.id]}</p>
        </div>
      </div>
    </div>
  );
}

function toneChip(tone: ConnectorStatus["tone"]): string {
  return tone === "live" ? "ok" : tone === "attn" ? "warn" : "";
}

const CEREMONY_LEAD = {
  host: "The authority plane. It authorizes every ConnectionRef and signs every receipt.",
  identity:
    "Who you are to the fabric. Sessions are minted here and never leave this device unwrapped.",
  machine:
    "Your local daemon. Ceremonies that touch this machine go through it.",
  history:
    "The vault lives on this device. Connect git to persist encrypted history as ciphertext. Agents never see these values.",
  keys: "Where vault and sealed-store keys are wrapped. WebCrypto on this device is the built-in default.",
} satisfies Record<ConnectorId, string>;

const CEREMONY_FOOT = {
  host: "GitHub Pages cannot host this plane. Locally it auto-connects; remotely you pair a daemon or point at a host you run.",
  identity:
    "Signing out of Identity does not lock the vault unless the strict option under Security is on.",
  machine:
    "Nothing to type in the happy path. If discovery finds nothing, run `curl -s http://127.0.0.1:18790/health` on the daemon machine and paste the tailscale_url it prints.",
  history:
    "The remote holds ciphertext only. Seal a manifest with `opensesame pass seal` before it ever reaches git.",
  keys: "Changing this re-wraps keys; it does not re-encrypt or re-upload your items.",
} satisfies Record<ConnectorId, string>;

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
    case "machine":
      return (
        <connectivityBarDependencies.ConnectThisMachine
          autoDiscover
          onPaired={onClose}
        />
      );
    case "host":
      return (
        <connectivityBarDependencies.HostCeremony
          connector={connector}
          onCheckNow={() => connectivityBarDependencies.checkNow()}
          onSwitch={onSwitch}
        />
      );
    case "identity":
      return <IdentityCeremony connector={connector} onClose={onClose} />;
    case "history":
      return <connectivityBarDependencies.ConnectGitHistory />;
    default:
      return <connectivityBarDependencies.KeyVaultCeremony onClose={onClose} />;
  }
}

/**
 * When this was last checked, when it will be checked next, and a way to say
 * "now". A status that will not say how old it is asks to be trusted blindly,
 * which is exactly what the old bar did wrong.
 */
function Freshness({ connector }: { connector: ConnectorStatus }) {
  const monitor = connectivityBarDependencies.useConnectivityMonitor();
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
      <button
        type="button"
        className="btn btn--sm"
        disabled={connector.checking || monitor.offline}
        onClick={() => connectivityBarDependencies.checkNow()}
      >
        Check now
      </button>
    </div>
  );
}
