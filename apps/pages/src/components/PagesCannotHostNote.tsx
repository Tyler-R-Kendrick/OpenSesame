import {
  hostStatusLabel,
  needsHostPairing,
  planeSeams,
  usePlaneStatus,
} from "../lib/planes.js";
import { CeremonyLink } from "./CeremonyLauncher.js";
import { IconAlert } from "./Icons.js";
import { ConnectThisMachine } from "./PlaneNote.js";

/**
 * The section-level reminder that GitHub Pages cannot host the planes.
 *
 * Lives in its own file rather than beside the machine ceremony because of
 * what it imports: opening a ceremony needs the connection sheet, the sheet's
 * body needs the machine ceremony, and keeping all three in one another's
 * modules made a cycle.
 *
 * When the Host is down, the way out is the Host ceremony — opened here, in
 * place. This used to be a link to Settings, which broke the one rule the
 * ceremonies keep: repairing a connection must put you back where you were.
 */
function PagesCannotHostNoteDefault({
  ceremony,
}: {
  ceremony: string;
}) {
  const status = usePlaneStatus();
  // Host plane is ready (or still probing a saved pairing) — do not ask again.
  if (status.host === "live" || status.host === "pending") return null;
  if (!needsHostPairing(status)) {
    if (status.host === "down") {
      return (
        <output className="note note--warn">
          <IconAlert />
          <div>
            <p>
              {ceremony} needs the Host API. {planeSeams.PAGES_CANNOT_HOST}
            </p>
            <p>
              Configured Host: <code>{status.hostBase || "none"}</code> (
              {hostStatusLabel(status.host).toLowerCase()}).
            </p>
            <CeremonyLink id="host">Repair the Host connection</CeremonyLink>
          </div>
        </output>
      );
    }
    return null;
  }
  return (
    <div className="panel">
      {/* The heading lives on the panel, not in the ceremony: inline, this
          panel is the only chrome around it, while in the connection sheet
          the sheet head already names the connector. */}
      <div className="panel__head">
        <div>
          <h2>Connect this machine</h2>
          <p>
            This page cannot see 127.0.0.1, so it pairs your daemon over
            Tailscale Serve instead.
          </p>
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
