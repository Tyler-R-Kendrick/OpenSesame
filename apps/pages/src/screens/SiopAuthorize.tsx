import type { NormalizedAuthorizationRequest } from "@opensesame/siop-v2";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { firstControl, keyboardIsIdle, landFocus } from "../lib/focus.js";
import {
  LocalDirectoryError,
  type LocalIdentity,
  readLocalDirectory,
} from "../lib/local-directory.js";
import {
  type LocalSession,
  signInLocalIdentity,
} from "../lib/local-sessions.js";
import {
  approveSiopAuthorization,
  bindSiopRequest,
  denySiopAuthorization,
  parsePagesSiopRequest,
} from "../lib/siop-authority.js";
import { useVaultStore } from "../lib/vault/hooks.js";

export function SiopAuthorize() {
  const { search } = useLocation();
  const tomb = useVaultStore().activeTomb();
  const request = useMemo(() => {
    try {
      return parsePagesSiopRequest(search);
    } catch {
      return null;
    }
  }, [search]);
  if (!request)
    return (
      <section className="panel" aria-label="Self-issued sign-in">
        <div className="panel__head">
          <h1>Invalid Self-Issued request</h1>
        </div>
        <div className="panel__body">
          <p role="alert">
            Start sign-in again from the registered application.
          </p>
          <Link to="/identity?view=applications">Manage applications</Link>
        </div>
      </section>
    );
  return (
    <SiopConsent key={`${tomb}:${search}`} tomb={tomb} request={request} />
  );
}

function SiopConsent({
  tomb,
  request,
}: { tomb: string; request: NormalizedAuthorizationRequest }) {
  const [people, setPeople] = useState<LocalIdentity[]>([]);
  const [application, setApplication] = useState("");
  const [person, setPerson] = useState("");
  const [session, setSession] = useState<LocalSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [finished, setFinished] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const redirectOrigin = useMemo(() => {
    try {
      return new URL(request.redirectUri).origin;
    } catch {
      return "unknown origin";
    }
  }, [request.redirectUri]);

  useEffect(() => {
    const current = ++generation.current;
    void (async () => {
      try {
        const bound = await bindSiopRequest(tomb, request);
        const directory = await readLocalDirectory(tomb);
        if (current !== generation.current) return;
        const members = new Set(
          directory.memberships
            .filter(
              (row) => row.organizationId === bound.application.organizationId,
            )
            .map((row) => row.principalId),
        );
        const app = directory.entries.find(
          (row) =>
            row.id === bound.application.applicationId &&
            row.kind === "application" &&
            row.enabled,
        );
        setApplication(app?.name ?? bound.application.applicationId);
        setPeople(
          directory.entries.filter(
            (row) =>
              row.kind === "person" && row.enabled && members.has(row.id),
          ),
        );
        setLoaded(true);
      } catch {
        if (current === generation.current)
          setError(
            "This Self-Issued request is unavailable. Check its registration in Identity, then start again from the application.",
          );
      }
    })();
    return () => {
      generation.current++;
    };
  }, [tomb, request]);

  useEffect(() => {
    if (loaded && !busy && !finished && keyboardIsIdle())
      landFocus(firstControl(root.current));
  });

  async function verifyPasskey() {
    if (busy || !person || finished) return;
    const current = generation.current;
    setBusy(true);
    setError("");
    try {
      const identity = await signInLocalIdentity(tomb, person);
      if (current === generation.current) setSession(identity);
    } catch (failure) {
      if (current === generation.current) {
        setSession(null);
        setError(
          failure instanceof LocalDirectoryError
            ? failure.message
            : "Sign-in was not completed. Retry with your enrolled passkey.",
        );
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  async function allow() {
    if (busy || !session || finished) return;
    const current = generation.current;
    setBusy(true);
    setError("");
    try {
      const { redirectUrl } = await approveSiopAuthorization(
        tomb,
        session,
        request,
      );
      if (current !== generation.current) return;
      setFinished(true);
      globalThis.location.replace(redirectUrl);
    } catch (failure) {
      if (current === generation.current) {
        setSession(null);
        setError(
          failure instanceof LocalDirectoryError
            ? failure.message
            : "Self-Issued sign-in was not completed. Retry with your enrolled passkey.",
        );
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  function deny() {
    if (busy || finished) return;
    setFinished(true);
    globalThis.location.replace(denySiopAuthorization(request));
  }

  return (
    <section
      className="panel"
      aria-label="Self-issued sign-in"
      aria-busy={busy}
    >
      <div className="panel__head">
        <h1>Self-issued sign-in to {application || "an application"}</h1>
      </div>
      <div className="panel__body">
        <p>
          Requesting site:{" "}
          <code className="identity-ref">{redirectOrigin}</code>
        </p>
        <details>
          <summary>Exact callback address</summary>
          <p className="identity-ref">{request.redirectUri}</p>
        </details>
        <p>
          Requested permissions: <code>openid</code>
        </p>
        <p className="hint">
          This returns a Self-Issued ID Token signed in your vault. The relying
          party verifies your public key from the response. No vault contents or
          upstream token are shared. SIOPv2 is an OpenID Implementer&apos;s
          Draft.
        </p>
        {error ? (
          <p role="alert" className="note note--err">
            {error}
          </p>
        ) : null}
        {!loaded && !error ? (
          <output>Reading application registration…</output>
        ) : null}
        <div ref={root}>
          {loaded && !finished && !error ? (
            <>
              <div className="field">
                <label className="label" htmlFor="siop-consent-person">
                  Person
                </label>
                <select
                  id="siop-consent-person"
                  value={person}
                  disabled={busy || session !== null}
                  onChange={(event) => setPerson(event.target.value)}
                >
                  <option value="">Choose a local person</option>
                  {people.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </div>
              {people.length === 0 ? (
                <p>
                  No enabled people belong to this application&apos;s
                  organization. Assign membership in Identity before signing in.
                </p>
              ) : null}
              <div className="actions">
                {session ? (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy}
                    onClick={() => void allow()}
                  >
                    Allow Self-Issued sign-in
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || !person}
                    onClick={() => void verifyPasskey()}
                  >
                    {busy ? "Verifying passkey…" : "Verify with passkey"}
                  </button>
                )}
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={deny}
                >
                  Deny
                </button>
              </div>
            </>
          ) : null}
          <p className="hint">
            <output aria-label="Self-issued sign-in status">
              {finished
                ? "Finishing Self-Issued sign-in…"
                : session
                  ? "Passkey verified. Review the site before allowing access."
                  : "Verify your local identity to continue."}
            </output>
          </p>
        </div>
      </div>
    </section>
  );
}
