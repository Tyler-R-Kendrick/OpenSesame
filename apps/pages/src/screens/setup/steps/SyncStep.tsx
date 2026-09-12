/**
 * Step 5 — sync. What this vault should sync with: cloud secret storage and
 * password managers. The binding lands in Settings as it is chosen, and a
 * connector that needs an account authorizes in place — Connect opens the
 * ceremony in a new tab and the card reports when it lands (ADR 0114).
 */

import { ConnectorCards } from "./ConnectorCards.js";
import { StepHead } from "./shared.js";

export function SyncStep() {
  return (
    <>
      <StepHead title="What should this vault sync with?">
        Sync roads keep ciphertext in step with a store you already run. A
        reveal stays human-gated on this device either way — an agent only ever
        holds a reference, never the secret.
      </StepHead>

      <section className="setup__stack" aria-label="Cloud secret storage">
        <h2 className="ways__head">Cloud secret storage</h2>
        <ConnectorCards id="cloud_secrets" />
      </section>

      <section className="setup__stack" aria-label="Password managers">
        <h2 className="ways__head">Password managers</h2>
        <ConnectorCards id="password_managers" />
        <p className="hint">
          Bringing an existing manager across? Settings › Data imports
          1Password, Bitwarden and KeePass files straight into the vault.
        </p>
      </section>
    </>
  );
}
