import { type Session, createOpenSesame } from "@opensesame/sdk-browser";
import { useCallback, useEffect, useMemo, useState } from "react";
import { issuer } from "../lib/issuer.js";

/**
 * Guest session issuance — the shareable on-ramp. Mints a provisional
 * principal with a short-lived lease; linking an upstream identity later
 * keeps the same principal id, so nothing started as a guest is lost.
 */
export function GuestSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sesame = useMemo(
    () => createOpenSesame({ issuer, clientId: "opensesame-ceremonies" }),
    [],
  );

  useEffect(() => {
    void sesame.getSession().then(setSession);
  }, [sesame]);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // A provisional principal is the default on-ramp: no account needed.
      // Claiming later (linking an identity) keeps the same principal id.
      setSession(await sesame.continueAnonymously());
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not start a guest session. Is the Identity API up?",
      );
    } finally {
      setBusy(false);
    }
  }, [sesame]);

  const end = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // Anonymous sign-out also revokes the lease server-side.
      await sesame.signOut();
      setSession(null);
    } finally {
      setBusy(false);
    }
  }, [sesame]);

  return (
    <section className="panel">
      <div className="badge">Guest session</div>
      <h1>Start a guest session</h1>
      <p>
        No account needed. You get a provisional identity with a short-lived
        lease, enough to accept claims and try things out. This surface never
        shows raw credentials.
      </p>
      {session ? (
        <div>
          <p>
            Guest session active
            {session.sub ? (
              <>
                {" "}
                as <code>{session.sub}</code>
              </>
            ) : null}
            . Link an account later in the console to keep this principal id.
          </p>
          <div className="actions">
            <button
              type="button"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void end()}
            >
              End guest session
            </button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void start()}
          >
            {busy ? "Starting…" : "Continue as guest"}
          </button>
        </div>
      )}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
