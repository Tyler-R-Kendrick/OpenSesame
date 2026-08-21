import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
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
import { failureSentence } from "../lib/probe-failure.js";
import { ConnectGitHistory } from "./ConnectGitHistory.js";
import {
  IconAuthority,
  IconGitBranch,
  IconLogin,
  IconTerminal,
  IconVault,
  IconX,
} from "./Icons.js";
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
const GLYPHS: Record<ConnectorId, (size: number) => ReactNode> = {
  host: (size) => <IconAuthority size={size} />,
  identity: (size) => <IconLogin size={size} />,
  machine: (size) => <IconTerminal size={size} />,
  history: (size) => <IconGitBranch size={size} />,
  keys: (size) => <IconVault size={size} />,
};

export function connectorGlyph(id: ConnectorId, size = 19): ReactNode {
  return GLYPHS[id](size);
}

function ConnectivityBarDefault() {
  const connectors = useConnectors();
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
              checkNow();
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
}: {
  id: ConnectorId;
  connectors: ConnectorStatus[];
  onClose: () => void;
}) {
  const connector = connectors.find((entry) => entry.id === id);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
          <CeremonyBody connector={connector} onClose={onClose} />
          <Freshness connector={connector} />
        </div>
      </div>
    </div>
  );
}

function toneChip(tone: ConnectorStatus["tone"]): string {
  return tone === "live" ? "ok" : tone === "attn" ? "warn" : "";
}

const CEREMONY_LEAD: Record<ConnectorId, string> = {
  host: "The authority plane. It authorizes every ConnectionRef and signs every receipt.",
  identity:
    "Who you are to the fabric. Sessions are minted here and never leave this device unwrapped.",
  machine:
    "Your local daemon. Ceremonies that touch this machine go through it.",
  history:
    "The vault lives on this device. Connect git to persist encrypted history as ciphertext. Agents never see these values.",
  keys: "Where vault and sealed-store keys are wrapped. WebCrypto on this device is the built-in default.",
};

function CeremonyBody({
  connector,
  onClose,
}: {
  connector: ConnectorStatus;
  onClose: () => void;
}) {
  switch (connector.id) {
    case "machine":
      return <ConnectThisMachine autoDiscover onPaired={onClose} />;
    case "host":
      return <PlaneCeremony kind="host" onClose={onClose} />;
    case "identity":
      return <PlaneCeremony kind="identity" onClose={onClose} />;
    case "history":
      return <ConnectGitHistory />;
    default:
      return <CapabilityCeremony connector={connector} onClose={onClose} />;
  }
}

/**
 * Host and Identity are not repaired here — they are re-probed here.
 *
 * Both are already correct out of the box on a loopback page, and off one they
 * come from pairing. So the ceremony's job is to say whether the plane answers
 * right now, and hand over to the two things that actually change it. The
 * check goes through the monitor rather than calling a probe directly: one
 * schedule, one in-flight request, one answer for every surface at once.
 */
function PlaneCeremony({
  kind,
  onClose,
}: {
  kind: "host" | "identity";
  onClose: () => void;
}) {
  const { connect, connecting, error } = useConnect();
  const [guestBusy, setGuestBusy] = useState(false);
  const [guestError, setGuestError] = useState<string | null>(null);
  const upstream = defaultUpstream();

  return (
    <>
      {kind === "identity" ? (
        <>
          <p className="hint">
            Registered sign-in uses {upstream.accountKind}. Continuing as a
            guest needs no passkey or password — you will be asked to claim this
            session from the notifications bell.
          </p>
          <div className="actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={connecting || guestBusy}
              onClick={() => {
                void beginSignIn(upstream, { returnTo: "/" });
              }}
            >
              Sign in with {upstream.accountKind}
            </button>
            <button
              type="button"
              className="btn"
              disabled={connecting || guestBusy}
              aria-busy={guestBusy}
              onClick={() => {
                setGuestBusy(true);
                setGuestError(null);
                void (async () => {
                  try {
                    await connect();
                    await claimGuestAuth();
                    onClose();
                  } catch (caught) {
                    setGuestError(
                      caught instanceof Error
                        ? caught.message
                        : "Guest login failed.",
                    );
                  } finally {
                    setGuestBusy(false);
                  }
                })();
              }}
            >
              {guestBusy ? "Starting guest…" : "Continue as guest"}
            </button>
          </div>
        </>
      ) : null}
      {error ? <StatusNote message={{ tone: "warn", text: error }} /> : null}
      {guestError ? (
        <StatusNote message={{ tone: "warn", text: guestError }} />
      ) : null}
      <p className="hint">
        Endpoints come from pairing this machine. To point at a plane someone
        else runs, open{" "}
        <Link to="/settings/connectivity" onClick={onClose}>
          Settings → Connectivity → Endpoints
        </Link>
        .
      </p>
    </>
  );
}

/**
 * When this was last checked, when it will be checked next, and a way to say
 * "now". A status that will not say how old it is asks to be trusted blindly,
 * which is exactly what the old bar did wrong.
 */
function Freshness({ connector }: { connector: ConnectorStatus }) {
  const monitor = useConnectivityMonitor();
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
        onClick={() => checkNow()}
      >
        Check now
      </button>
    </div>
  );
}

/**
 * Keys are bound in the capability connectors panel — the one place that
 * knows the catalog. Git has its own ceremony, matching Host / Identity /
 * this machine. This sheet says what is bound and takes you there.
 */
function CapabilityCeremony({
  connector,
  onClose,
}: {
  connector: ConnectorStatus;
  onClose: () => void;
}) {
  return (
    <>
      <p className="hint">
        Cloud KMS and hardware connectors are optional. Changing this re-wraps
        keys; it does not re-encrypt or re-upload your items.
      </p>
      <div className="actions">
        <Link
          className="btn btn--primary"
          to="/settings/connectivity"
          onClick={onClose}
        >
          {connector.tone === "live" ? "Change connector" : "Set up"}
        </Link>
      </div>
    </>
  );
}
