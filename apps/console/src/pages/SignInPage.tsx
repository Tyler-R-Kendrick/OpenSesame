import type { BoundaryValue } from "@opensesame/os-domain";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { clearClaimStash } from "../lib/claim-stash.js";
import {
  type FederatedProviderSummary,
  listFederatedProviders,
} from "../lib/federated-providers.js";
import { createOpenSesame } from "../sdk-browser.js";

const issuer =
  import.meta.env.VITE_OPENSESAME_ISSUER ?? "http://127.0.0.1:8788";

/**
 * What this console offered before there was a catalog: the upstream broker
 * that fronts Google. It stays as the fallback so a deployment that publishes
 * no catalog — or an Identity API that cannot be reached from this tab — still
 * has a working federated button.
 */
const FALLBACK_PROVIDERS: FederatedProviderSummary[] = [
  { id: "shoo", label: "Google", kind: "oidc", browserCapable: true },
];

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
  const [busy, setBusy] = useState<string | null>(null);
  const [providers, setProviders] =
    useState<FederatedProviderSummary[]>(FALLBACK_PROVIDERS);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    void listFederatedProviders(issuer).then((list) => {
      // An empty catalog keeps the fallback rather than leaving the console
      // with no federated entry at all.
      if (!cancelled && list.length > 0) setProviders(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
        {providers.map((provider) => (
          <button
            key={provider.id}
            type="button"
            disabled={busy !== null}
            aria-busy={busy === `provider:${provider.id}`}
            onClick={() => {
              setError(null);
              setBusy(`provider:${provider.id}`);
              // The hosted login page runs the upstream leg and pre-selects
              // this provider from the hint the SDK sends under both names.
              void sesame
                .signIn({ provider: provider.id })
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
            {busy === `provider:${provider.id}`
              ? "Opening sign-in…"
              : `Sign in with ${provider.label}`}
          </button>
        ))}
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
