/**
 * The phone's status chrome, as one item in the nav it already has.
 *
 * A desktop statusline can afford five connector glyphs side by side: the row
 * is a glance that costs nothing, and the pips are the whole point of it. A
 * phone cannot, and the answer is not a shorter strip — it is no strip. A
 * second full-width bar under the tab bar is a row of the frame spent on
 * things a person looks at rarely, and every phone platform puts exactly that
 * behind the last item of the nav it already draws.
 *
 * So on a phone the statusline is not drawn at all: notifications, help, the
 * keymap and the five connectors live behind one key in the bar the phone
 * already has at the top, where an overflow belongs and where the prompt's
 * `flex: 1` leaves room for it at every width. It carries a dot whenever
 * something inside wants attention, so nothing that used to be glanceable
 * stopped being glanceable — a pip on a strip and a dot on a key say the same
 * thing for the same reason.
 *
 * It is deliberately not a sixth tab. The tab bar divides its width between
 * five labels, and a sixth column clipped "Connections" to "Connecti…" at 320,
 * 390 and 430 alike — the `cqi` clamp sizes type against the bar, which does
 * not shrink when a column is added. The top bar has the room the nav does
 * not.
 *
 * The rows are the same `.conn` tiles Settings already draws for this list, so
 * the menu introduces no pattern of its own, and it gives the keymap sheet its
 * first affordance on a phone: `?` opened it on a desktop and nothing did here.
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
import { useSupport } from "../tutorial/session.js";
import { ConnectionCeremony, connectorGlyph } from "./ConnectivityBar.js";
import { IconBell, IconDots, IconHelp, IconTerminal, IconX } from "./Icons.js";
import { NotificationsBar, useNoticeCount } from "./NotificationsBar.js";

/**
 * The worst tone in the set, which is the one a single dot has to report.
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

export function MoreMenu() {
  const connectors = useConnectors();
  const [open, setOpen] = useState(false);
  // The notifications sheet is a sibling of the menu, never a child: closing
  // the menu would unmount it, and leaving the menu open behind it stacks two
  // scrims and squeezes it into a sliver against the bottom edge.
  const [notices, setNotices] = useState(false);
  const [ceremony, setCeremony] = useState<ConnectorId | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const tone = aggregateTone(connectors);
  // The dot is the strip's pips, summed: anything inside that wants a person.
  const waiting = useNoticeCount();
  const attention = tone === "attn" || tone === "offline" || waiting > 0;
  const label = `More — ${summarize(connectors)}`;
  useModalFocus(open, sheetRef, closeRef, () => setOpen(false));

  return (
    <>
      <button
        type="button"
        className={`icon-btn topbar__more${attention ? " is-attn" : ""}`}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <IconDots size={18} />
      </button>

      {open ? (
        <MoreSheet
          connectors={connectors}
          waiting={waiting}
          closeRef={closeRef}
          sheetRef={sheetRef}
          onClose={() => setOpen(false)}
          onNotices={() => {
            setOpen(false);
            setNotices(true);
          }}
          onPick={(id) => {
            setOpen(false);
            setCeremony(id);
          }}
        />
      ) : null}

      {notices ? (
        <NotificationsBar form="panel" onClose={() => setNotices(false)} />
      ) : null}

      {ceremony ? (
        <ConnectionCeremony
          id={ceremony}
          connectors={connectors}
          onClose={() => setCeremony(null)}
          onSwitch={(next) => setCeremony(next)}
        />
      ) : null}
    </>
  );
}

/**
 * What the statusline used to hold: notifications, help, the keymap, and the
 * five connectors as named rows rather than as glyphs nobody can tell apart.
 */
function MoreSheet({
  connectors,
  waiting,
  closeRef,
  sheetRef,
  onClose,
  onNotices,
  onPick,
}: {
  connectors: ConnectorStatus[];
  waiting: number;
  closeRef: RefObject<HTMLButtonElement | null>;
  sheetRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onNotices: () => void;
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
        aria-label="More"
        aria-modal="true"
      >
        <div className="sheet__head">
          <div className="sheet__grow">
            <h2>More</h2>
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
          <UtilityRows
            waiting={waiting}
            onClose={onClose}
            onNotices={onNotices}
          />
          <h3 className="more__head">Connections</h3>
          <ConnectionRows connectors={connectors} onPick={onPick} />
        </div>
      </div>
    </div>
  );
}

/** Notifications, help and the keymap: the strip's non-connector business. */
function UtilityRows({
  waiting,
  onClose,
  onNotices,
}: { waiting: number; onClose: () => void; onNotices: () => void }) {
  const { support } = useSupport();
  return (
    <div className="more__rows">
      <button
        type="button"
        className="more__row"
        aria-haspopup="dialog"
        onClick={onNotices}
      >
        <IconBell size={17} />
        <span className="more__name">Notifications</span>
        <span className={waiting > 0 ? "more__n is-attn" : "more__n"}>
          {waiting === 0 ? "none" : waiting}
        </span>
      </button>
      <button
        type="button"
        className="more__row"
        onClick={() => {
          onClose();
          support.open();
        }}
      >
        <IconHelp size={17} />
        <span className="more__name">Help</span>
      </button>
      <button
        type="button"
        className="more__row"
        onClick={() => {
          onClose();
          showKeymapHelp();
        }}
      >
        <IconTerminal size={17} />
        <span className="more__name">Keyboard shortcuts</span>
      </button>
    </div>
  );
}

/** The five connectors, as the tiles Settings already draws for this list. */
function ConnectionRows({
  connectors,
  onPick,
}: {
  connectors: ConnectorStatus[];
  onPick: (id: ConnectorId) => void;
}) {
  return (
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
  );
}
