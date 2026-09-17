import { needsHostPairing, usePlaneStatus } from "../lib/planes.js";
import { ConnectThisMachine } from "./PlaneNote.js";

/**
 * The section-level reminder that GitHub Pages cannot host the planes.
 *
 * Lives in its own file rather than beside the machine ceremony because of
 * what it imports: opening a ceremony needs the connection sheet, the sheet's
 * body needs the machine ceremony, and keeping all three in one another's
 * modules made a cycle.
 *
 * Pairing stays optional: an unset or down Host posts no tray notice.
 */
function PagesCannotHostNoteDefault({
  ceremony: _ceremony,
}: {
  ceremony: string;
}) {
  const status = usePlaneStatus();
  // Host/daemon pairing is optional. A missing or down Host is not an error
  // and must not post a tray notice. The ceremony argument is kept so this
  // note can be plugged back in later without changing call sites.
  void _ceremony;
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
