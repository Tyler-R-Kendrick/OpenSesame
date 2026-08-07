import { useState } from "react";
import { createOpenSesame } from "@opensesame/sdk-browser";

const issuer =
  import.meta.env.VITE_OPENSESAME_ISSUER ?? "http://127.0.0.1:8788";

export function SignInPage() {
  const [error, setError] = useState<string | null>(null);
  const [sessionHint, setSessionHint] = useState<string | null>(null);

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
          onClick={() => {
            void sesame.signIn().catch((e: unknown) => {
              setError(e instanceof Error ? e.message : String(e));
            });
          }}
        >
          Sign in with OpenSesame
        </button>
        <button
          type="button"
          onClick={() => {
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
                setError(e instanceof Error ? e.message : String(e));
              });
          }}
        >
          Continue anonymously
        </button>
        <button
          type="button"
          onClick={() => {
            void sesame.signOut();
            setSessionHint(null);
          }}
        >
          Sign out
        </button>
      </div>
      {sessionHint ? <p>{sessionHint}</p> : null}
      {error ? <p className="err">{error}</p> : null}
    </section>
  );
}
