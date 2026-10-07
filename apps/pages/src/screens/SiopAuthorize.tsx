import {
  LocalDirectoryError,
  type LocalIdentity,
  readLocalDirectory,
} from "@opensesame/app-core/lib/local-directory.js";
import {
  type LocalSession,
  signInLocalIdentity,
} from "@opensesame/app-core/lib/local-sessions.js";
import {
  approveSiopAuthorization,
  bindSiopRequest,
  denySiopAuthorization,
  parsePagesSiopRequest,
  recordSiopDenial,
} from "@opensesame/app-core/lib/siop-authority.js";
import type { NormalizedAuthorizationRequest } from "@opensesame/siop-v2";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { FailureNotice } from "../components/FailureNotice.js";
import { FormCommit } from "../components/FormCommit.js";
import { IconKey } from "../components/IconKey.js";
import { IconPasskey, IconX } from "../components/Icons.js";
import {
  runSessionNavigation,
  sessionNavigationAllowed,
} from "../lib/decoy-navigation.js";
import { firstControl, keyboardIsIdle, landFocus } from "../lib/focus.js";
import { useOnce } from "../lib/use-once.js";
import { useVault } from "../lib/vault/hooks.js";

export function SiopAuthorize() {
  const { search } = useLocation();
  const { tomb } = useVault();
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
          <FailureNotice
            id="siop-authorize:request"
            title="Invalid Self-Issued request"
            message="Start sign-in again from the registered application."
          />
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
      runSessionNavigation(redirectUrl, () =>
        globalThis.location.replace(redirectUrl),
      );
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

  // A refusal is recorded once, however fast it is pressed twice: `finished`
  // is this render's, and a second press can land before the next one.
  const refuse = useOnce(async () => {
    const redirect = denySiopAuthorization(request);
    if (!sessionNavigationAllowed(redirect)) {
      setError("External navigation is unavailable in this session.");
      return;
    }
    setFinished(true);
    try {
      await recordSiopDenial(tomb, request);
      runSessionNavigation(redirect, () =>
        globalThis.location.replace(redirect),
      );
    } catch {
      setError("The refusal could not be completed in this session.");
    }
  });

  function deny() {
    if (busy || finished) return;
    void refuse();
  }

  const status = finished
    ? "Finishing sign-in…"
    : session
      ? "Passkey verified."
      : "Verify to continue.";

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
        <dl aria-label="Self-issued authorization boundaries">
          <dt>Response</dt>
          <dd>Self-Issued ID Token signed in your vault.</dd>
          <dt>Verification</dt>
          <dd>The relying party verifies your public key from the response.</dd>
          <dt>Shared material</dt>
          <dd>No vault contents or upstream token.</dd>
          <dt>Protocol</dt>
          <dd>SIOPv2 is an OpenID Implementer&apos;s Draft.</dd>
        </dl>
        <FailureNotice
          id="siop-authorize:consent"
          title="Self-issued sign-in"
          message={error}
        />
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
              <SiopCommit
                signedIn={Boolean(session)}
                busy={busy}
                canVerify={Boolean(person)}
                onAllow={() => void allow()}
                onVerify={() => void verifyPasskey()}
                onDeny={deny}
              />
            </>
          ) : null}
          <p className="hint">
            <output aria-label="Self-issued sign-in status">{status}</output>
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * The consent's commit: allow once a person has proven themselves, verify
 * with a passkey before that — and deny beside either, on the same row.
 */
function SiopCommit(props: {
  signedIn: boolean;
  busy: boolean;
  canVerify: boolean;
  onAllow: () => void;
  onVerify: () => void;
  onDeny: () => void;
}) {
  const { signedIn, busy } = props;
  const verify = busy ? "Verifying passkey…" : "Verify with passkey";
  return (
    <FormCommit
      label={signedIn ? "Allow Self-Issued sign-in" : verify}
      icon={signedIn ? undefined : <IconPasskey size={18} />}
      disabled={busy || !(signedIn || props.canVerify)}
      onClick={signedIn ? props.onAllow : props.onVerify}
    >
      <IconKey label="Deny" disabled={busy} onClick={props.onDeny}>
        <IconX size={16} />
      </IconKey>
    </FormCommit>
  );
}
