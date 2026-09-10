import { useEffect, useState } from "react";
import { LocalDirectoryError } from "../../lib/local-directory.js";
import { subscribeLocalIamChanges } from "../../lib/local-iam-events.js";
import type { LocalSession } from "../../lib/local-sessions.js";

export function useLocalSessionPresentation(tomb: string, principalId: string) {
  const [session, setSession] = useState<LocalSession | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let generation = 0;
    async function refresh() {
      const request = ++generation;
      try {
        const api = await import("../../lib/local-sessions.js");
        const current = await api.currentLocalIdentitySession(
          tomb,
          principalId,
        );
        if (request !== generation) return;
        setSession(current);
        setError("");
        setMessage(
          current
            ? current.authentication === "passkey"
              ? "Signed in locally with a passkey. No application access was granted."
              : "Signed in locally with an agent key. No human approval or application access was granted."
            : "No active local session.",
        );
      } catch {
        if (request !== generation) return;
        setSession(null);
        setMessage("Local session unavailable.");
        setError(
          "Could not validate this local session. Unlock the vault and retry.",
        );
      }
    }
    const listener = () => {
      void refresh();
    };
    const unsubscribe = subscribeLocalIamChanges(listener);
    window.addEventListener("focus", listener);
    listener();
    return () => {
      generation++;
      unsubscribe();
      window.removeEventListener("focus", listener);
    };
  }, [tomb, principalId]);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(
      () => {
        setSession(null);
        setMessage("Local session expired. Sign in again.");
      },
      Math.max(0, session.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [session]);
  return { session, setSession, message, setMessage, error, setError };
}

export function LocalIdentitySession({
  tomb,
  principalId,
  disabled,
}: {
  tomb: string;
  principalId: string;
  disabled: boolean;
}) {
  const { session, setSession, message, setMessage, error, setError } =
    useLocalSessionPresentation(tomb, principalId);
  const [busy, setBusy] = useState(false);

  async function run(signOut: boolean) {
    if (busy || (!signOut && disabled)) return;
    setBusy(true);
    setError("");
    try {
      const api = await import("../../lib/local-sessions.js");
      if (signOut) {
        if (session) await api.revokeLocalIdentitySession(tomb, session.id);
        setSession(null);
        setMessage("No active local session.");
      } else {
        const next = await api.signInLocalIdentity(tomb, principalId);
        setSession(next);
        setMessage(
          "Signed in locally with a passkey. No application access was granted.",
        );
      }
    } catch (failure) {
      setError(
        failure instanceof LocalDirectoryError
          ? failure.message
          : "The local session operation failed. Unlock the vault and retry.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="identity-session" aria-busy={busy}>
      <div className="actions">
        <button
          type="button"
          className="btn btn--sm"
          disabled={disabled || busy || session !== null}
          onClick={() => void run(false)}
        >
          Sign in locally
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={busy || session === null}
          onClick={() => void run(true)}
        >
          Sign out locally
        </button>
      </div>
      <output aria-label="Local session status">
        {busy ? "Complete the local session operation…" : message}
      </output>
      {error ? (
        <p role="alert" className="note note--err">
          {error}
        </p>
      ) : null}
      {session ? (
        <p className="hint">
          Session expires {new Date(session.expiresAt).toLocaleTimeString()}.
          Organization access follows assigned roles.
        </p>
      ) : null}
    </div>
  );
}
