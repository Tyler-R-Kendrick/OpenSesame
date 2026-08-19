import { type Session, createOpenSesame } from "@opensesame/sdk-browser";
import { useEffect, useMemo, useState } from "react";
import "./rp.css";

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
  const [phase, setPhase] = useState<"idle" | "completing" | "ready">("idle");

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
      setPhase("completing");
      void sesame
        .handleRedirectCallback(window.location.href)
        .then((s) => {
          setSession(s);
          setPhase("ready");
          history.replaceState(null, "", "/");
        })
        .catch((e: unknown) => {
          setError(
            e instanceof Error
              ? e.message
              : "Sign-in callback failed. Try signing in again.",
          );
          setPhase("idle");
        });
      return;
    }
    void sesame.getSession().then((s) => {
      setSession(s);
      setPhase("ready");
    });
  }, [sesame]);

  function demoMockVerify() {
    const seed = `${props.sector}:demo-principal`;
    const digest = Array.from(new TextEncoder().encode(seed))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
    setMockSub(`pw_${digest}`);
  }

  return (
    <main className="shell">
      <p className="brand">OpenSesame</p>
      <div className="badge">Example relying party</div>
      <h1>{props.name}</h1>
      <p className="lede">
        client_id=<code>{props.clientId}</code> · sector=
        <code>{props.sector}</code>
      </p>
      <p className="lede">
        Pairwise <code>sub</code> is sector-specific. Canonical principal ids
        are never shown.
      </p>
      <div className="panel">
        {phase === "completing" ? (
          <output className="lede" aria-busy="true">
            Completing sign-in…
          </output>
        ) : null}
        {phase === "ready" && !session ? (
          <output className="lede">
            Signed out. Sign in to receive a pairwise subject for this sector.
          </output>
        ) : null}
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={phase === "completing"}
            onClick={() => void sesame.signIn()}
          >
            Sign in
          </button>
          <button
            type="button"
            disabled={phase === "completing"}
            onClick={demoMockVerify}
          >
            Demo pairwise sub (mock)
          </button>
          <button
            type="button"
            disabled={phase === "completing"}
            onClick={() => {
              void sesame.signOut();
              setSession(null);
              setMockSub(null);
              setPhase("ready");
            }}
          >
            Sign out
          </button>
        </div>
        {session ? (
          <output className="ok">
            Session pairwise sub:{" "}
            <strong>{session.sub ?? "present (opaque token)"}</strong>
          </output>
        ) : null}
        {mockSub ? (
          <output className="ok">
            Mock verified pairwise sub: <strong>{mockSub}</strong>
          </output>
        ) : null}
        {error ? (
          <p className="err" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </main>
  );
}
