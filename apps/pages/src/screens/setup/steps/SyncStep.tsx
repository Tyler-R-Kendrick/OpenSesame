/**
 * Step 5 — sync. What this vault should sync with: cloud secret storage and
 * password managers. The bindings land in Settings as they are chosen;
 * authorization completes from Settings › Connections once a Host is paired.
 */

import { CapabilityChoices, StepHead } from "./shared.js";

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
        <CapabilityChoices id="cloud_secrets" />
      </section>

      <section className="setup__stack" aria-label="Password managers">
        <h2 className="ways__head">Password managers</h2>
        <CapabilityChoices id="password_managers" />
        <p className="hint">
          Bringing an existing manager across? Settings › Data imports
          1Password, Bitwarden and KeePass files straight into the vault.
        </p>
      </section>
    </>
  );
}
