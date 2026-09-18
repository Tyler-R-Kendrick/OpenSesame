import { type FormEvent, useId, useState } from "react";
import { useVault } from "../../lib/vault/hooks.js";
import {
  armVercelConnectAuth,
  forgetVercelConnectAuth,
} from "../../lib/vercel-connect-session.js";
import {
  type VercelConnectAuth,
  useVercelConnectConfigured,
  vercelConnectAuth,
} from "../../lib/vercel-connect.js";

/** Arms the live Connect transport from a sealed (or staged) Vercel token. */
export function ConnectSessionNote() {
  const configured = useVercelConnectConfigured();
  const { status, tomb, guest } = useVault();
  const [token, setToken] = useState("");
  const [teamId, setTeamId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenId = useId();
  const teamIdField = useId();
  const openTomb = status === "unlocked" ? (tomb ?? null) : null;
  const ephemeral = status === "unlocked" && guest === true;

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next: VercelConnectAuth = { token: token.trim() };
      const team = teamId.trim();
      if (team) next.teamId = team;
      await armVercelConnectAuth(next, openTomb, { ephemeral });
      setToken("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setError(null);
    try {
      await forgetVercelConnectAuth(ephemeral ? null : openTomb);
      setToken("");
      setTeamId("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not clear.");
    } finally {
      setBusy(false);
    }
  }

  if (configured) {
    const auth = vercelConnectAuth();
    return (
      <aside className="plane-note" aria-label="Vercel Connect session">
        <p>
          Connect session armed
          {auth?.teamId ? ` for team ${auth.teamId}` : ""}. Live list and
          authorize use Vercel Connect; Host stays the fallback when none is
          set.
        </p>
        <button type="button" className="btn" onClick={() => void clear()}>
          Clear session
        </button>
        {error ? <p className="err">{error}</p> : null}
      </aside>
    );
  }

  return (
    <aside className="plane-note" aria-label="Vercel Connect session">
      <p>
        To use live Connect without a Host, seal a Vercel access token in this
        vault. Nothing is baked into the static Pages build.
      </p>
      <form className="stack" onSubmit={(event) => void save(event)}>
        <label htmlFor={tokenId}>Vercel token</label>
        <input
          id={tokenId}
          name="vercel-token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          required
          minLength={8}
        />
        <label htmlFor={teamIdField}>Team id (optional)</label>
        <input
          id={teamIdField}
          name="vercel-team"
          value={teamId}
          onChange={(event) => setTeamId(event.target.value)}
        />
        {error ? <p className="err">{error}</p> : null}
        <button type="submit" className="btn" disabled={busy || !token.trim()}>
          {busy ? "Saving…" : "Arm Connect"}
        </button>
      </form>
    </aside>
  );
}
