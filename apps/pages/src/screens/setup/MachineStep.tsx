/**
 * Setup step 3 — pair this machine.
 *
 * Deliberately thin: `ConnectThisMachine` is the pairing ceremony, and it
 * already handles the whole of it — probing what was saved, sweeping the
 * tailnet, opening the Tailscale client and waiting for the tailnet to come
 * up, the manual Serve URL, the QR for a second device, and writing Host and
 * Identity out of the daemon's own health record. A setup-shaped copy of that
 * would be a second implementation of the hardest flow in the app.
 *
 * Discovery is not started on arrival. Sweeping a tailnet raises Chrome's
 * local-network permission dialog, and a first-run visitor who has not asked
 * for anything should not meet a browser permission prompt they cannot place.
 */

import { ConnectThisMachine } from "../../components/PlaneNote.js";

export function MachineStep({ onPaired }: { onPaired: () => void }) {
  return (
    <div className="setup__stack">
      <ConnectThisMachine onPaired={onPaired} />
      <p className="hint">
        Optional. Pairing is what lets this page reach a Host and Identity API
        that live on your own machine — a static deployment cannot call{" "}
        <code>127.0.0.1</code>, so the daemon's Tailscale Serve URL stands in
        for it.
      </p>
    </div>
  );
}
