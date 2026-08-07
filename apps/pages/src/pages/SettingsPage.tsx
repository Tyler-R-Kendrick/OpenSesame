import { useState, type FormEvent } from "react";
import { loadSettings, saveSettings, type PagesSettings } from "../lib/settings.js";

export function SettingsPage() {
  const [form, setForm] = useState<PagesSettings>(() => loadSettings());
  const [saved, setSaved] = useState(false);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    saveSettings({
      hostApi: form.hostApi.trim().replace(/\/$/, ""),
      identityApi: form.identityApi.trim().replace(/\/$/, ""),
      operatorToken: form.operatorToken.trim(),
    });
    setSaved(true);
  }

  return (
    <section className="panel">
      <h1>Settings</h1>
      <p>
        Base URLs for online calls. Stored only in this browser. GitHub Pages
        cannot host the Host or Identity planes.
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
          Operator token (optional, for Host task routes)
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
            Save locally
          </button>
        </div>
      </form>
      {saved ? (
        <p className="ok" role="status">
          Settings saved in this browser.
        </p>
      ) : null}
    </section>
  );
}
