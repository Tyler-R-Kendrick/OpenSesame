import { useState } from "react";
import type { OAuthClient } from "../../lib/directory.js";
import { updateApplication } from "../../lib/identity-management.js";

export function EditApplication({
  client,
  online,
  onSaved,
  onCancel,
}: {
  client: OAuthClient;
  online: boolean;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(client.displayName);
  const [redirects, setRedirects] = useState(client.redirectUris.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      await updateApplication(
        client.id,
        name.trim(),
        redirects
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      );
      onSaved();
    } catch {
      setError(
        "Could not save the application; check ownership and exact redirect URLs.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3>Edit application</h3>
      <div className="field">
        <label className="label" htmlFor="identity-app-name">
          Application name
        </label>
        <input
          id="identity-app-name"
          required
          maxLength={128}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="identity-app-redirects">
          Redirect URIs (one per line)
        </label>
        <textarea
          id="identity-app-redirects"
          required
          value={redirects}
          disabled={busy}
          onChange={(event) => setRedirects(event.target.value)}
        />
      </div>
      <p className="hint">
        Authorization code with PKCE S256; exact redirects and the existing
        subject sector remain enforced by Identity.
      </p>
      {error ? (
        <p className="note note--err" role="alert">
          {error}
        </p>
      ) : null}
      <div className="actions">
        <button
          type="submit"
          className="btn btn--primary"
          disabled={busy || !online || !name.trim() || !redirects.trim()}
        >
          {busy ? "Saving…" : "Save application"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
