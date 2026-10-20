import {
  beginSignIn,
  loadSession,
} from "@opensesame/app-core/lib/federation.js";
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
  type SiopSocialProof,
  approveSiopAuthorization,
  approveSiopAuthorizationWithSocial,
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
import { IconLogin, IconPasskey, IconX } from "../components/Icons.js";
import { StatusMark } from "../components/StatusMark.js";
import { firstControl, keyboardIsIdle, landFocus } from "../lib/focus.js";
import {
  type SiopSocialChoice,
  clearSiopSocialAttempt,
  readSiopSocialAttempt,
  saveSiopSocialAttempt,
  siopSocialReturnTo,
  useSiopSocialChoices,
} from "../lib/siop-social.js";
import { useOnce } from "../lib/use-once.js";
import { useVault } from "../lib/vault/hooks.js";
import { brandFor } from "./unlock/ProviderBrand.js";

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
  const [socialProof, setSocialProof] = useState<SiopSocialProof | null>(null);
  const [socialBusy, setSocialBusy] = useState(false);
  const [socialError, setSocialError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [finished, setFinished] = useState(false);
  const socialChoices = useSiopSocialChoices();
  const { search } = useLocation();
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

  // A hosted identity provider returns to this page with its own session
  // already adopted. The attempt in sessionStorage says which provider and
  // which local person the redirect belonged to; a reload never trusts a
  // stale `social` query by itself.
  useEffect(() => {
    if (!loaded) return;
    const id = new URLSearchParams(search).get("social");
    const attempt = readSiopSocialAttempt(id);
    if (!attempt) return;
    if (attempt.personId !== person) {
      if (people.some((entry) => entry.id === attempt.personId)) {
        setPerson(attempt.personId);
      } else {
        clearSiopSocialAttempt();
        setSocialError(
          "Choose the local person you started social sign-in with.",
        );
      }
      return;
    }
    if (attempt.source !== "identity") return;
    const upstream = loadSession();
    if (
      !upstream ||
      upstream.upstreamId !== attempt.upstreamId ||
      upstream.expiresAt <= Date.now()
    ) {
      clearSiopSocialAttempt();
      setSocialError("That social sign-in expired. Choose it again.");
      return;
    }
    clearSiopSocialAttempt();
    setSocialProof({
      source: "identity",
      providerId: attempt.providerId,
      label: attempt.label,
      personId: attempt.personId,
      at: Date.now(),
      upstreamId: attempt.upstreamId,
    });
  }, [loaded, people, person, search]);

  useEffect(() => {
    if (socialProof && socialProof.personId !== person) setSocialProof(null);
  }, [person, socialProof]);

  useEffect(() => {
    if (loaded && !busy && !socialBusy && !finished && keyboardIsIdle())
      landFocus(firstControl(root.current));
  });

  function chooseSocial(choice: SiopSocialChoice): void {
    if (busy || socialBusy || session || !person || finished) return;
    setSocialError("");
    setError("");
    if (choice.source === "connection") {
      if (!choice.connectionId) return;
      setSocialProof({
        source: "connection",
        providerId: choice.providerId,
        label: choice.accountLabel
          ? `${choice.label} · ${choice.accountLabel}`
          : choice.label,
        personId: person,
        at: Date.now(),
        connectionId: choice.connectionId,
      });
      return;
    }
    if (!choice.upstream || !choice.upstreamId) return;
    const attempt = {
      id: crypto.randomUUID(),
      source: "identity" as const,
      providerId: choice.providerId,
      label: choice.label,
      personId: person,
      at: Date.now(),
      upstreamId: choice.upstreamId,
    };
    saveSiopSocialAttempt(attempt);
    setSocialBusy(true);
    void beginSignIn(choice.upstream, {
      returnTo: siopSocialReturnTo(attempt.id),
      providerHint: choice.upstream.providerHint,
    }).catch((failure: unknown) => {
      clearSiopSocialAttempt();
      setSocialBusy(false);
      setSocialError(
        failure instanceof Error
          ? failure.message
          : "That social sign-in did not start.",
      );
    });
  }

  async function verifyPasskey() {
    if (busy || !person || finished) return;
    const current = generation.current;
    setBusy(true);
    setSocialProof(null);
    setSocialError("");
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
    if (busy || (!session && !socialProof) || finished) return;
    const current = generation.current;
    setBusy(true);
    setError("");
    try {
      const approved = socialProof
        ? await approveSiopAuthorizationWithSocial(tomb, socialProof, request)
        : session
          ? await approveSiopAuthorization(tomb, session, request)
          : null;
      if (!approved || current !== generation.current) return;
      const { redirectUrl } = approved;
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

  // A refusal is recorded once, however fast it is pressed twice: `finished`
  // is this render's, and a second press can land before the next one.
  const refuse = useOnce(async () => {
    setFinished(true);
    await recordSiopDenial(tomb, request);
    globalThis.location.replace(denySiopAuthorization(request));
  });

  function deny() {
    if (busy || finished) return;
    void refuse();
  }

  const status = finished
    ? "Finishing sign-in…"
    : socialProof
      ? `Signed in with ${socialProof.label}.`
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
        <p className="hint">Shares no vault contents.</p>
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
                  disabled={busy || socialBusy || session !== null}
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
              {socialChoices.length > 0 && !session ? (
                <div className="siop-social" aria-label="Social sign-in">
                  <h2>Social sign-in</h2>
                  {!person ? (
                    <StatusMark
                      tone="idle"
                      label="Choose a local person first."
                    />
                  ) : null}
                  <ul>
                    {socialChoices.map((choice) => {
                      const brand = brandFor(choice.providerId);
                      return (
                        <li key={choice.id} className="siop-social__row">
                          <button
                            type="button"
                            className={`icon-btn icon-btn--sm${brand ? ` ${brand.className}` : ""}`}
                            aria-label={`Continue with ${choice.label}`}
                            title={`Continue with ${choice.label}`}
                            disabled={
                              busy ||
                              socialBusy ||
                              !person ||
                              Boolean(socialProof)
                            }
                            onClick={() => chooseSocial(choice)}
                          >
                            {brand ? (
                              <brand.Icon size={16} />
                            ) : (
                              <IconLogin size={16} />
                            )}
                          </button>
                          <span className="go-verb" aria-hidden="true">
                            {choice.label}
                            {choice.accountLabel
                              ? ` · ${choice.accountLabel}`
                              : ""}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
              {socialError ? (
                <FailureNotice
                  id="siop-authorize:social"
                  title="Social sign-in"
                  message={socialError}
                />
              ) : null}
              <SiopCommit
                signedIn={Boolean(session || socialProof)}
                busy={busy || socialBusy}
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
