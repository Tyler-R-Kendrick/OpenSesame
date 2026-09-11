/**
 * Step 1 — backups. Where ciphertext (never plaintext) should persist
 * beyond this device: an encrypted git history, the local daemon, or an
 * exported file. Git connectors authorize in place — Connect opens the
 * ceremony in a new tab and the card reports when it lands (ADR 0114).
 */

import { useState } from "react";
import { loadSettings, saveSettings } from "../../../lib/settings.js";
import { ConnectorCards } from "./ConnectorCards.js";
import { StepHead } from "./shared.js";

/**
 * The daemon's address. A loopback suggestion the person confirms, never a
 * default the app assumes (ADR 0090) — empty means "no daemon here".
 */
function DaemonField() {
  const [value, setValue] = useState(() => loadSettings().daemonApi);
  const commit = (next: string) => {
    setValue(next);
    const current = loadSettings();
    saveSettings({ ...current, daemonApi: next });
  };
  return (
    <label className="field">
      <span>Daemon address</span>
      <input
        type="url"
        value={value}
        onChange={(event) => commit(event.target.value)}
        placeholder="http://127.0.0.1:18790"
        autoComplete="off"
        spellCheck={false}
      />
    </label>
  );
}

export function BackupsStep() {
  return (
    <>
      <StepHead title="Where do backups live?">
        The vault already lives on this device, sealed. A backup road pushes
        ciphertext — never plaintext — to a place you also control. The choice
        lands in Settings as it is made and can change any time.
      </StepHead>

      <section className="setup__stack" aria-label="Encrypted git history">
        <h2 className="ways__head">Encrypted git history</h2>
        <ConnectorCards id="history" />
        <p className="hint">
          Connect opens the provider in a new tab; pick or create the repo from
          Settings › Backup once it lands. A local password-store needs no
          account at all.
        </p>
      </section>

      <section className="setup__stack" aria-label="Daemon on this machine">
        <h2 className="ways__head">Daemon on this machine</h2>
        <p className="hint">
          The daemon is the local host agent — it holds connections on this
          machine so the browser never has to. Build it from the repository with{" "}
          <code>cargo build -p opensesame-daemon</code> and run it on loopback,
          then name its address here.
        </p>
        <DaemonField />
      </section>

      <p className="hint">
        No remote at all? Settings › Data exports one encrypted file you can
        keep anywhere.
      </p>
    </>
  );
}
