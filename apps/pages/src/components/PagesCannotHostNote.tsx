import {
  hostStatusLabel,
  needsHostPairing,
  planeSeams,
  usePlaneStatus,
} from "../lib/planes.js";
import { useStatusNotice } from "../lib/use-status-notice.js";
import { ConnectThisMachine } from "./PlaneNote.js";

/**
 * The section-level reminder that GitHub Pages cannot host the planes.
 *
 * Lives in its own file rather than beside the machine ceremony because of
 * what it imports: opening a ceremony needs the connection sheet, the sheet's
 * body needs the machine ceremony, and keeping all three in one another's
 * modules made a cycle.
 *
 * A down Host is standing trouble, not page furniture — it reports to the
 * notifications tray so the section renders its own content clean. The way
 * out stays the Host ceremony, opened from the tray in place: repairing a
 * connection must put you back where you were.
 */
function PagesCannotHostNoteDefault({
  ceremony,
}: {
  ceremony: string;
}) {
  const status = usePlaneStatus();
  const hostDown = status.host === "down" && !needsHostPairing(status);
  useStatusNotice(
    hostDown
      ? {
          id: "host-down",
          tone: "warn",
          title: "Host API unavailable",
          body:
            `${ceremony} needs the Host API. ${planeSeams.PAGES_CANNOT_HOST} ` +
            `Configured Host: ${status.hostBase || "none"} (${hostStatusLabel(
              status.host,
            ).toLowerCase()}).`,
          ceremony: "host",
          ceremonyLabel: "Repair the Host connection",
        }
      : null,
  );
  // Host plane is ready (or still probing a saved pairing) — do not ask again.
  if (status.host === "live" || status.host === "pending") return null;
  if (!needsHostPairing(status)) return null;
  return (
    <div className="panel">
      {/* The heading lives on the panel, not in the ceremony: inline, this
          panel is the only chrome around it, while in the connection sheet
          the sheet head already names the connector. */}
      <div className="panel__head">
        <div>
          <h2>Connect this machine</h2>
        </div>
      </div>
      <div className="panel__body">
        <ConnectThisMachine />
      </div>
    </div>
  );
}

export const pagesCannotHostNoteSeams = {
  PagesCannotHostNote: PagesCannotHostNoteDefault,
};

export function PagesCannotHostNote(
  props: Parameters<typeof PagesCannotHostNoteDefault>[0],
) {
  const Impl = pagesCannotHostNoteSeams.PagesCannotHostNote;
  return <Impl {...props} />;
}
