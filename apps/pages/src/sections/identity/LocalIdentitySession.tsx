import { LocalDirectoryError } from "@opensesame/app-core/lib/local-directory.js";
import { subscribeLocalIamChanges } from "@opensesame/app-core/lib/local-iam-events.js";
import type { LocalSession } from "@opensesame/app-core/lib/local-sessions.js";
import { useEffect, useState } from "react";
import { IconLock, IconPasskey } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

export function useLocalSessionPresentation(tomb: string, principalId: string) {
  const [session, setSession] = useState<LocalSession | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let generation = 0;
    async function refresh() {
      const request = ++generation;
      try {
        const api = await import("@opensesame/app-core/lib/local-sessions.js");
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
      const api = await import("@opensesame/app-core/lib/local-sessions.js");
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

  const tone = error ? "err" : session ? "ok" : "idle";
  const label =
    error || (busy ? "Complete the local session operation…" : message);

  return (
    <div className="identity-session" aria-busy={busy}>
      <div className="actions">
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          disabled={disabled || busy || session !== null}
          onClick={() => void run(false)}
          aria-label="Sign in locally"
          title="Sign in locally"
        >
          <IconPasskey size={16} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          disabled={busy || session === null}
          onClick={() => void run(true)}
          aria-label="Sign out locally"
          title="Sign out locally"
        >
          <IconLock size={16} />
        </button>
        <StatusMark tone={tone} label={label || "No active local session."} />
      </div>
      {error ? (
        <span role="alert" className="visually-hidden">
          {error}
        </span>
      ) : (
        <output className="visually-hidden" aria-label="Local session status">
          {busy ? "Complete the local session operation…" : message}
        </output>
      )}
    </div>
  );
}
