/**
 * Settings → General → Install.
 *
 * The setup ceremony runs once and can be skipped; this is where the offer
 * lives for good. Someone who walked past it on first run, or who opened the
 * same deployment on a second device, finds it here rather than hunting for
 * the icon their browser hides in the address bar.
 *
 * Same component and the same rule as the ceremony step (ADR 0086): present
 * when there is an install to make or one to report, absent when there is
 * neither. `InstallOffer` renders nothing in the `unavailable` case, and the
 * panel goes with it — the heading is not worth a row that explains what this
 * browser will not do.
 */

import { InstallOffer } from "../../components/InstallOffer.js";
import { useInstall } from "../../lib/use-install.js";

export function InstallPanel() {
  // The same value the card below reads, from the same store: a panel that
  // disagreed with its own body about whether there is an install to make
  // would render a heading over nothing.
  const { visible } = useInstall();
  if (!visible) return null;

  return (
    <section className="panel" aria-labelledby="settings-install">
      <div className="panel__head">
        <div>
          <h2 id="settings-install">Install</h2>
        </div>
      </div>
      <div className="panel__body">
        <InstallOffer />
      </div>
    </section>
  );
}
