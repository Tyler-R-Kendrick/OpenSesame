/**
 * Step — backups (after connectors, so history can reuse directory endpoints).
 */

import { useState } from "react";
import { loadSettings, saveSettings } from "../../../lib/settings.js";
import { BackupGroups } from "./BackupGroups.js";

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
      <BackupGroups />
      <section className="setup__stack" aria-label="Daemon on this machine">
        <DaemonField />
      </section>
    </>
  );
}
