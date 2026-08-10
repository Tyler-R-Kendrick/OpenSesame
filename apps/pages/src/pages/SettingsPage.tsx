import { type FormEvent, useState } from "react";
import {
  type PagesSettings,
  SettingsRejected,
  loadSettings,
  saveSettings,
} from "../lib/settings.js";
import { track } from "../lib/telemetry.js";

export function SettingsPage() {
  const [form, setForm] = useState<PagesSettings>(() => loadSettings());
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      saveSettings({
        hostApi: form.hostApi.trim().replace(/\/$/, ""),
        identityApi: form.identityApi.trim().replace(/\/$/, ""),
        operatorToken: form.operatorToken.trim(),
      });
      track("settings_changed");
      setError(null);
      setSaved(true);
    } catch (err) {
      setSaved(false);
      setError(
        err instanceof SettingsRejected
          ? err.message
          : "Those settings could not be saved.",
      );
    }
  }

  return (
    <section className="panel">
      <h1>Settings</h1>
      <p>
        Host/Identity URLs persist in OPFS (memory fallback) and must be https,
        or http on loopback. The operator token is session-only, never written
        to durable storage, and only ever sent to a Host API on this machine.
        GitHub Pages cannot host the Host or Identity planes.
      </p>
      <form onSubmit={onSubmit}>
        <label htmlFor="host">
          Host API
          <input
            id="host"
            type="url"
            value={form.hostApi}
            onChange={(e) => setForm({ ...form, hostApi: e.target.value })}
          />
        </label>
        <label htmlFor="identity">
          Identity API
          <input
            id="identity"
            type="url"
            value={form.identityApi}
            onChange={(e) => setForm({ ...form, identityApi: e.target.value })}
          />
        </label>
        <label htmlFor="operator">
          Operator token (optional, session-only, for Host task routes)
          <input
            id="operator"
            type="password"
            autoComplete="off"
            value={form.operatorToken}
            onChange={(e) =>
              setForm({ ...form, operatorToken: e.target.value })
            }
          />
        </label>
        <div className="actions">
          <button type="submit" className="primary">
            Save
          </button>
        </div>
      </form>
      {saved ? (
        <output className="ok">Settings saved in this browser.</output>
      ) : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
