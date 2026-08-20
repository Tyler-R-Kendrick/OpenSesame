import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";
import {
  type ConnectorId,
  type ConnectorStatus,
  needsAttention,
  useConnectors,
} from "../lib/connectors.js";
import {
  type HealthState,
  probeHost,
  probeIdentity,
  useConnect,
} from "../lib/identity.js";
import {
  IconAuthority,
  IconGitBranch,
  IconLogin,
  IconTerminal,
  IconVault,
  IconX,
} from "./Icons.js";
import { ConnectThisMachine } from "./PlaneNote.js";

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

export function ConnectivityBar() {
  const connectors = useConnectors();
  const [open, setOpen] = useState<ConnectorId | null>(null);
  const attention = needsAttention(connectors);

  return (
    <>
      {/* A fieldset, as the theme switcher already does — the group role comes
          from the element rather than an attribute. */}
      <fieldset
        className="cx"
        aria-label={
          attention === 1
            ? "Connections — 1 needs setup"
            : attention > 1
              ? `Connections — ${attention} need setup`
              : "Connections — all connected"
        }
      >
        {connectors.map((connector) => (
          <button
            key={connector.id}
            type="button"
            className={`cx__btn cx__btn--${connector.tone}`}
            // The glyph carries no text, so the whole status has to live in the
            // accessible name — a screen reader gets the same glance we do.
            aria-label={`${connector.name} — ${connector.detail}`}
            title={`${connector.name} — ${connector.detail}`}
            onClick={() => setOpen(connector.id)}
          >
            {connectorGlyph(connector.id)}
            <span className="cx__pip" aria-hidden="true" />
          </button>
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
      {/* A real <dialog>, kept in normal flow rather than the top layer so it
          sits inside the app frame the way the design draws it. */}
      <dialog
        open
        className="sheet"
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
          <CeremonyBody connector={connector} onClose={onClose} />
        </div>
      </dialog>
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
    "Encrypted history is pushed to a git remote as ciphertext. Agents never see these values.",
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
    default:
      return <CapabilityCeremony connector={connector} onClose={onClose} />;
  }
}

/**
 * Host and Identity are not repaired here — they are re-probed here.
 *
 * Both are already correct out of the box on a loopback page, and off one they
 * come from pairing. So the ceremony's job is to say whether the plane answers
 * right now, and hand over to the two things that actually change it.
 */
function PlaneCeremony({
  kind,
  onClose,
}: {
  kind: "host" | "identity";
  onClose: () => void;
}) {
  const [result, setResult] = useState<HealthState | null>(null);
  const [checking, setChecking] = useState(false);
  const { connect, connecting, error } = useConnect();

  async function check() {
    setChecking(true);
    setResult(null);
    try {
      setResult(await (kind === "host" ? probeHost() : probeIdentity()));
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <div className="actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={checking}
          aria-busy={checking}
          onClick={() => void check()}
        >
          {checking ? "Checking…" : "Check again"}
        </button>
        {kind === "identity" ? (
          <button
            type="button"
            className="btn"
            disabled={connecting}
            aria-busy={connecting}
            onClick={() => void connect()}
          >
            {connecting ? "Signing in…" : "Sign in"}
          </button>
        ) : null}
      </div>
      {result ? (
        <output
          className={`note note--${result === "reachable" ? "ok" : "warn"}`}
        >
          {result === "reachable"
            ? "Answered just now."
            : "No answer. Pair this machine, or point Settings at a plane you run."}
        </output>
      ) : null}
      {error ? <output className="note note--warn">{error}</output> : null}
      <p className="hint">
        Endpoints come from pairing this machine. To point at a plane someone
        else runs, open{" "}
        <Link to="/settings#connectivity" onClick={onClose}>
          Settings → Connectivity → Endpoints
        </Link>
        .
      </p>
    </>
  );
}

/**
 * History and keys are bound in the capability connectors panel — the one
 * place that knows the catalog, the OAuth scopes and the remote. The ceremony
 * says what is bound and takes you there rather than growing a second copy.
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
        {connector.id === "history"
          ? "Authorize a git connector to push and pull ciphertext. The remote holds ciphertext only — seal a manifest with `opensesame pass seal` before it ever reaches git."
          : "Cloud KMS and hardware connectors are optional. Changing this re-wraps keys; it does not re-encrypt or re-upload your items."}
      </p>
      <div className="actions">
        <Link
          className="btn btn--primary"
          to="/settings#connectivity"
          onClick={onClose}
        >
          {connector.tone === "live" ? "Change connector" : "Set up"}
        </Link>
      </div>
    </>
  );
}
