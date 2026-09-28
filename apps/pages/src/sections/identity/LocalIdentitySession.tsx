import { LocalDirectoryError } from "@opensesame/app-core/lib/local-directory.js";
import { subscribeLocalIamChanges } from "@opensesame/app-core/lib/local-iam-events.js";
import type { LocalSession } from "@opensesame/app-core/lib/local-sessions.js";
import { MEMBERSHIP_CHANGED_SIGN_IN_AGAIN } from "@opensesame/app-core/sections/identity/member-organizations-model.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconLock, IconPasskey } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { LocalMemberOrganizations } from "./LocalMemberOrganizations.js";

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

/**
 * A committed membership edit ends every local session (ADR 0104 revision
 * binding). Revalidate rather than assume: say so only once the library no
 * longer honours the session, then hand focus to Sign in locally if it fell.
 */
function useMembershipEnded(
  tomb: string,
  principalId: string,
  presentation: ReturnType<typeof useLocalSessionPresentation>,
) {
  const { session, setSession, setMessage } = presentation;
  const [changed, setChanged] = useState(false);
  const signIn = useRef<HTMLButtonElement>(null);
  const ended = changed && session === null;
  useLayoutEffect(() => {
    if (ended && document.activeElement === document.body)
      signIn.current?.focus();
  }, [ended]);
  async function confirmEnded() {
    try {
      const api = await import("@opensesame/app-core/lib/local-sessions.js");
      if (await api.currentLocalIdentitySession(tomb, principalId)) return;
      setSession(null);
      setMessage("No active local session.");
      setChanged(true);
    } catch {
      setSession(null);
      setMessage("Local session unavailable.");
    }
  }
  return { ended, setChanged, signIn, confirmEnded };
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
  const presentation = useLocalSessionPresentation(tomb, principalId);
  const { session, setSession, message, setMessage, error, setError } =
    presentation;
  const [busy, setBusy] = useState(false);
  const { ended, setChanged, signIn, confirmEnded } = useMembershipEnded(
    tomb,
    principalId,
    presentation,
  );

  async function run(signOut: boolean) {
    if (busy || (!signOut && disabled)) return;
    setBusy(true);
    setError("");
    setChanged(false);
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
  const current = ended ? MEMBERSHIP_CHANGED_SIGN_IN_AGAIN : message;
  const label =
    error || (busy ? "Complete the local session operation…" : current);

  return (
    <div className="identity-session" aria-busy={busy}>
      <div className="actions">
        <button
          ref={signIn}
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
          {busy ? "Complete the local session operation…" : current}
        </output>
      )}
      {session ? (
        <LocalMemberOrganizations
          tomb={tomb}
          session={session}
          onChanged={() => void confirmEnded()}
        />
      ) : null}
    </div>
  );
}
