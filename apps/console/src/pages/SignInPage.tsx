import { useState } from "react";
import { createOpenSesame } from "@opensesame/sdk-browser";
import { clearClaimStash } from "../lib/claim-stash.js";

const issuer =
  import.meta.env.VITE_OPENSESAME_ISSUER ?? "http://127.0.0.1:8788";

export function SignInPage() {
  const [error, setError] = useState<string | null>(null);
  const [sessionHint, setSessionHint] = useState<string | null>(null);
  const [busy, setBusy] = useState<"signIn" | "anon" | null>(null);

  const sesame = createOpenSesame({
    issuer,
    clientId: "opensesame-console",
    redirectUri: `${window.location.origin}/`,
  });

  return (
    <section className="panel">
      <h1>Sign in</h1>
      <p>
        Authenticate with an upstream identity or continue as a provisional
        principal. Claiming later attaches ownership without changing resource
        ids.
      </p>
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy !== null}
          aria-busy={busy === "signIn"}
          onClick={() => {
            setError(null);
            setBusy("signIn");
            void sesame
              .signIn()
              .catch((e: unknown) => {
                setError(
                  e instanceof Error
                    ? e.message
                    : "Sign-in failed. Check the Identity API and try again.",
                );
              })
              .finally(() => setBusy(null));
          }}
        >
          {busy === "signIn" ? "Opening sign-in…" : "Sign in with OpenSesame"}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          aria-busy={busy === "anon"}
          onClick={() => {
            setError(null);
            setBusy("anon");
            // A new principal in this tab: a claim opened for the previous one
            // is not this one's to accept.
            clearClaimStash();
            void sesame
              .continueAnonymously()
              .then((s) => {
                setSessionHint(
                  s.anonymous
                    ? "Provisional session active"
                    : `Signed in as ${s.sub ?? "unknown"}`,
                );
              })
              .catch((e: unknown) => {
                setError(
                  e instanceof Error
                    ? e.message
                    : "Could not start a provisional session.",
                );
              })
              .finally(() => setBusy(null));
          }}
        >
          {busy === "anon" ? "Starting…" : "Continue anonymously"}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => {
            void sesame.signOut();
            // Whoever signs in next must not inherit a claim this account was
            // part way through accepting.
            clearClaimStash();
            setSessionHint(null);
            setError(null);
          }}
        >
          Sign out
        </button>
      </div>
      {sessionHint ? (
        <p className="ok" role="status">
          {sessionHint}
        </p>
      ) : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
