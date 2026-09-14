/**
 * The statusline's overflow — where status lives on a phone.
 *
 * A desktop statusline can afford five connector glyphs side by side: the row
 * is a glance that costs nothing, and the pips are the whole point of it. A
 * phone cannot. Seven 44px keys are 308px, which is a 320px screen edge to
 * edge, and six of the seven are mute until something goes wrong — a full band
 * of chrome spent saying nothing. Every phone platform answers this the same
 * way: one summary indicator, with an overflow behind it.
 *
 * So on a phone the five glyphs roll up into this one key. It carries the
 * aggregate pip, so attention is still glanceable without opening anything,
 * and the sheet behind it says in words what five undifferentiated glyphs
 * never did: each connector's name and its one line of truth. The rows are the
 * same `.conn` tiles Settings already uses for exactly this list, so the
 * overflow introduces no new pattern — it reuses the one that exists.
 *
 * It also gives the keymap sheet its first touch affordance. `?` opened it on
 * a desktop and nothing opened it on a phone.
 */

import { type RefObject, useRef, useState } from "react";
import {
  type ConnectorId,
  type ConnectorStatus,
  isOfflineSet,
  needsAttention,
  useConnectors,
} from "../lib/connectors.js";
import { showKeymapHelp } from "../lib/keymap.js";
import { useModalFocus } from "../lib/modal-focus.js";
import { ConnectionCeremony, connectorGlyph } from "./ConnectivityBar.js";
import { IconDots, IconTerminal, IconX } from "./Icons.js";

/**
 * The worst tone in the set, which is the one a single pip has to report.
 * Offline outranks attention because with no network nothing else is knowable;
 * `off` is the resting state of a connector nobody has configured.
 */
function aggregateTone(connectors: ConnectorStatus[]): ConnectorStatus["tone"] {
  if (isOfflineSet(connectors)) return "offline";
  if (needsAttention(connectors) > 0) return "attn";
  if (connectors.length > 0 && connectors.every((c) => c.tone === "live")) {
    return "live";
  }
  return "off";
}

/** The same sentence the desktop bar puts on its group, said of one key. */
function summarize(connectors: ConnectorStatus[]): string {
  if (isOfflineSet(connectors)) return "offline";
  const attention = needsAttention(connectors);
  if (attention === 1) return "1 connection needs setup";
  if (attention > 1) return `${attention} connections need setup`;
  if (connectors.every((c) => c.tone === "live")) return "all connected";
  return "nothing needs setup";
}

const ACTION: Record<ConnectorStatus["tone"], string> = {
  live: "Connected",
  attn: "Set up",
  off: "Connect",
  offline: "Offline",
};

export function StatuslineMore() {
  const connectors = useConnectors();
  const [open, setOpen] = useState(false);
  const [ceremony, setCeremony] = useState<ConnectorId | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const tone = aggregateTone(connectors);
  const label = `More — ${summarize(connectors)}`;
  useModalFocus(open, sheetRef, closeRef, () => setOpen(false));

  return (
    <div className="statusline__more">
      <button
        type="button"
        className={`cx__btn cx__btn--${tone}${tone === "attn" ? " cx__btn--attn" : ""}`}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <IconDots size={19} />
        <span className="cx__pip" aria-hidden="true" />
      </button>

      {open ? (
        <ConnectionsSheet
          connectors={connectors}
          closeRef={closeRef}
          sheetRef={sheetRef}
          onClose={() => setOpen(false)}
          onPick={(id) => {
            setOpen(false);
            setCeremony(id);
          }}
        />
      ) : null}

      {ceremony ? (
        <ConnectionCeremony
          id={ceremony}
          connectors={connectors}
          onClose={() => setCeremony(null)}
          onSwitch={(next) => setCeremony(next)}
        />
      ) : null}
    </div>
  );
}

/**
 * The five connectors as named rows, and the keymap sheet's first affordance
 * on a phone. The rows are the `.conn` tiles Settings already uses for exactly
 * this list, so the overflow introduces no pattern of its own.
 */
function ConnectionsSheet({
  connectors,
  closeRef,
  sheetRef,
  onClose,
  onPick,
}: {
  connectors: ConnectorStatus[];
  closeRef: RefObject<HTMLButtonElement | null>;
  sheetRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onPick: (id: ConnectorId) => void;
}) {
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
        aria-label="Status and more"
        aria-modal="true"
      >
        <div className="sheet__head">
          <div className="sheet__grow">
            <h2>Connections</h2>
            <p>{summarize(connectors)}</p>
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
          <div className="conn-grid">
            {connectors.map((connector) => (
              <button
                key={connector.id}
                type="button"
                className={`conn conn--${connector.tone}`}
                onClick={() => onPick(connector.id)}
              >
                <span className="conn__mark" aria-hidden="true">
                  {connectorGlyph(connector.id, 20)}
                </span>
                <span className="conn__grow">
                  <span className="conn__name">{connector.name}</span>
                  <span className="conn__state">{connector.detail}</span>
                </span>
                <span className="conn__act">{ACTION[connector.tone]}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn--block statusline__keys"
            onClick={() => {
              onClose();
              showKeymapHelp();
            }}
          >
            <IconTerminal size={16} />
            Keyboard shortcuts
          </button>
        </div>
      </div>
    </div>
  );
}
