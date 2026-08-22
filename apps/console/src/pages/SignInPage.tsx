import type { BoundaryValue } from "@opensesame/os-domain";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { clearClaimStash } from "../lib/claim-stash.js";
import { createOpenSesame } from "../sdk-browser.js";

const issuer =
  import.meta.env.VITE_OPENSESAME_ISSUER ?? "http://127.0.0.1:8788";

/** The upstream broker that fronts Google for this deployment. */
const GOOGLE_PROVIDER = "shoo";

function createClient() {
  return createOpenSesame({
    issuer,
    clientId: "opensesame-console",
    redirectUri: `${window.location.origin}/`,
  });
}

/** An authorization response landed here: a code to spend, or a refusal. */
function isCallbackReturn(search: string): boolean {
  const params = new URLSearchParams(search);
  if (params.has("error")) return true;
  return params.has("code") && params.has("state");
}

export function SignInPage() {
  const [error, setError] = useState<string | null>(null);
  const [sessionHint, setSessionHint] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    "signIn" | "google" | "anon" | "callback" | null
  >(null);
  const navigate = useNavigate();

  /**
   * The PKCE verifier is spent by the first exchange, so a second call would
   * fail on state the first one already consumed. A ref survives StrictMode's
   * remount; a state flag is reset by it.
   */
  const callbackStarted = useRef(false);

  useEffect(() => {
    if (callbackStarted.current) return;
    if (!isCallbackReturn(window.location.search)) return;
    callbackStarted.current = true;
    const sesame = createClient();
    setBusy("callback");
    setError(null);
    // handleRedirectCallback scrubs code/state/error from the URL itself, and
    // on a refusal it also drops the verifier the redirect left behind.
    void sesame
      .handleRedirectCallback()
      .then((s) => {
        setSessionHint(`Signed in as ${s.sub ?? "unknown"}`);
        const returnTo = sesame.getReturnTo();
        if (returnTo) navigate(returnTo, { replace: true });
      })
      .catch((e: BoundaryValue) => {
        setError(
          e instanceof Error
            ? e.message
            : "Sign-in could not be completed. Try again.",
        );
      })
      .finally(() => setBusy(null));
  }, [navigate]);

  const sesame = createClient();

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
              .catch((e: BoundaryValue) => {
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
          aria-busy={busy === "google"}
          onClick={() => {
            setError(null);
            setBusy("google");
            void sesame
              .signIn({ provider: GOOGLE_PROVIDER })
              .catch((e: BoundaryValue) => {
                setError(
                  e instanceof Error
                    ? e.message
                    : "Sign-in failed. Check the Identity API and try again.",
                );
              })
              .finally(() => setBusy(null));
          }}
        >
          {busy === "google" ? "Opening sign-in…" : "Sign in with Google"}
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
              .catch((e: BoundaryValue) => {
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
      {sessionHint ? <output className="ok">{sessionHint}</output> : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
