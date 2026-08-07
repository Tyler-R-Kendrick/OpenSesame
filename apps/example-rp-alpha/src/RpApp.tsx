import { useEffect, useMemo, useState } from "react";
import { createOpenSesame, type Session } from "@opensesame/sdk-browser";

const issuer =
  import.meta.env.VITE_OPENSESAME_ISSUER ?? "http://127.0.0.1:8788";

export function RpApp(props: {
  name: string;
  clientId: string;
  sector: string;
  port: number;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mockSub, setMockSub] = useState<string | null>(null);

  const sesame = useMemo(
    () =>
      createOpenSesame({
        issuer,
        clientId: props.clientId,
        redirectUri: `http://127.0.0.1:${props.port}/`,
      }),
    [props.clientId, props.port],
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("code")) {
      void sesame
        .handleRedirectCallback(window.location.href)
        .then((s) => {
          setSession(s);
          history.replaceState(null, "", "/");
        })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : String(e));
        });
      return;
    }
    void sesame.getSession().then(setSession);
  }, [sesame]);

  function demoMockVerify() {
    // Demo pairwise sub without live control-plane: deterministic per sector.
    const seed = `${props.sector}:demo-principal`;
    const digest = Array.from(new TextEncoder().encode(seed))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
    setMockSub(`pw_${digest}`);
  }

  return (
    <main style={{ fontFamily: "IBM Plex Sans, sans-serif", padding: "2rem", maxWidth: 640 }}>
      <h1>{props.name}</h1>
      <p>
        client_id=<code>{props.clientId}</code> · sector=<code>{props.sector}</code>
      </p>
      <p>
        Pairwise <code>sub</code> is sector-specific. Canonical principal ids are never shown.
      </p>
      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <button type="button" onClick={() => void sesame.signIn()}>
          Sign in
        </button>
        <button type="button" onClick={demoMockVerify}>
          Demo pairwise sub (mock verify)
        </button>
        <button
          type="button"
          onClick={() => {
            void sesame.signOut();
            setSession(null);
            setMockSub(null);
          }}
        >
          Sign out
        </button>
      </div>
      {session ? (
        <p>
          Session pairwise sub: <strong>{session.sub ?? "(from access token)"}</strong>
        </p>
      ) : null}
      {mockSub ? (
        <p>
          Mock verified pairwise sub: <strong>{mockSub}</strong>
        </p>
      ) : null}
      {error ? <p style={{ color: "crimson" }}>{error}</p> : null}
    </main>
  );
}
