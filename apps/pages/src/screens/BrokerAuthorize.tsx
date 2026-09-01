/**
 * Broker authorize popup — ADR 0034 / federated-signin.md §2.
 * Runs without unlocking the vault: federation session lives in sessionStorage.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import {
  FederationError,
  type UpstreamIdentity,
  beginSignIn,
  clearSession,
  defaultUpstream,
  displayName,
  loadSession,
} from "../lib/federation.js";
import {
  type BrokerRequest,
  approveConsent,
  buildErrorMessage,
  buildSuccessMessage,
  consentCovers,
  consentFor,
  deliverToRp,
  domainFilterDenialMessage,
  originMayUseBroker,
  parseBrokerRequest,
  touchConsent,
} from "../lib/site-broker.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { useSupportRoute } from "../tutorial/session.js";
import "./broker.css";

type Phase =
  | { kind: "invalid"; error: string; detail: string; state?: string }
  | { kind: "loading" }
  | { kind: "blocked"; request: BrokerRequest; detail: string }
  | { kind: "sign_in"; request: BrokerRequest }
  | { kind: "consent"; request: BrokerRequest; identity: UpstreamIdentity }
  | { kind: "busy"; label: string }
  | { kind: "done"; via: string }
  | { kind: "error"; message: string };

function resumePath(request: BrokerRequest): string {
  const params = new URLSearchParams({
    client_id: request.clientId,
    origin: request.origin,
    state: request.state,
    scope: request.scope,
  });
  return `/broker/authorize?${params.toString()}`;
}

export function BrokerAuthorize() {
  useSupportRoute("/broker/authorize");
  const rootRef = useGuideTarget<HTMLDivElement>("broker.consent");
  const [searchParams] = useSearchParams();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  const parsed = useMemo(
    () => parseBrokerRequest(searchParams.toString()),
    [searchParams],
  );

  const released = useRef(false);

  const release = useCallback(
    (request: BrokerRequest, session: UpstreamIdentity, remember: boolean) => {
      if (released.current) return;
      released.current = true;
      if (remember) {
        approveConsent(request.origin, request.scope);
      } else {
        touchConsent(request.origin);
      }
      const message = buildSuccessMessage(request, session);
      const via = deliverToRp(message, request.origin, {
        redirectUri: searchParams.get("redirect_uri"),
      });
      setPhase({
        kind: "done",
        via:
          via === "postMessage"
            ? "Sent to the site. You can close this window."
            : via === "fragment"
              ? "Redirecting back to the site…"
              : "Could not reach the site window. Copy failed — close this tab and try again from the site.",
      });
    },
    [searchParams],
  );

  const deny = useCallback(
    (request: BrokerRequest) => {
      const message = buildErrorMessage(
        request.state,
        "consent_denied",
        "You refused this origin.",
      );
      deliverToRp(message, request.origin, {
        redirectUri: searchParams.get("redirect_uri"),
      });
      setPhase({ kind: "done", via: "Denied. You can close this window." });
    },
    [searchParams],
  );

  useEffect(() => {
    if (!parsed.ok) {
      setPhase({
        kind: "invalid",
        error: parsed.error,
        detail: parsed.detail,
        state: new URLSearchParams(searchParams).get("state") ?? undefined,
      });
      return;
    }

    const request = parsed.request;

    if (!originMayUseBroker(request.origin)) {
      const detail = domainFilterDenialMessage(request.origin);
      const message = buildErrorMessage(
        request.state,
        "registration_required",
        detail,
      );
      deliverToRp(message, request.origin, {
        redirectUri: searchParams.get("redirect_uri"),
        close: false,
      });
      setPhase({ kind: "blocked", request, detail });
      return;
    }

    const session = loadSession();

    if (!session) {
      setPhase({ kind: "sign_in", request });
      return;
    }

    const prior = consentFor(request.origin);
    if (consentCovers(prior, request.scope)) {
      touchConsent(request.origin);
      release(request, session, false);
      return;
    }

    setPhase({ kind: "consent", request, identity: session });
  }, [parsed, release, searchParams]);

  const startUpstream = async (request: BrokerRequest) => {
    setPhase({ kind: "busy", label: "Redirecting to sign-in…" });
    try {
      const upstream = defaultUpstream();
      await beginSignIn(upstream, {
        scope: request.scope.includes("openid")
          ? request.scope
          : `openid ${request.scope}`.trim(),
        returnTo: resumePath(request),
      });
    } catch (error) {
      const message =
        error instanceof FederationError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Sign-in failed.";
      setPhase({ kind: "error", message });
    }
  };

  return (
    <div ref={rootRef} className="broker">
      <header className="broker__head">
        <p className="broker__brand">OpenSesame</p>
        <h1>Sign in for a static site</h1>
      </header>

      <main className="broker__main">
        {phase.kind === "loading" ? (
          <p className="broker__status">Checking request…</p>
        ) : null}

        {phase.kind === "invalid" ? (
          <div className="broker__card broker__card--err" role="alert">
            <h2>Invalid request</h2>
            <p>
              <code>{phase.error}</code> — {phase.detail}
            </p>
          </div>
        ) : null}

        {phase.kind === "error" ? (
          <div className="broker__card broker__card--err" role="alert">
            <h2>Something went wrong</h2>
            <p>{phase.message}</p>
          </div>
        ) : null}

        {phase.kind === "busy" ? (
          <p className="broker__status">{phase.label}</p>
        ) : null}

        {phase.kind === "done" ? (
          <div className="broker__card">
            <h2>Done</h2>
            <p>{phase.via}</p>
          </div>
        ) : null}

        {phase.kind === "blocked" ? (
          <div className="broker__card broker__card--err" role="alert">
            <h2>Domain not allowed</h2>
            <p>
              <code className="broker__origin">{phase.request.origin}</code>
            </p>
            <p>{phase.detail}</p>
          </div>
        ) : null}

        {phase.kind === "sign_in" ? (
          <div className="broker__card">
            <h2>Sign in first</h2>
            <p>
              Approving{" "}
              <code className="broker__origin">{phase.request.origin}</code>{" "}
              needs you signed in at OpenSesame via{" "}
              {defaultUpstream().displayName} ({defaultUpstream().accountKind}).
            </p>
            <button
              type="button"
              className="broker__btn"
              onClick={() => void startUpstream(phase.request)}
            >
              Continue with {defaultUpstream().accountKind}
            </button>
          </div>
        ) : null}

        {phase.kind === "consent" ? (
          <div className="broker__card">
            <h2>Allow this site?</h2>
            <p>
              Signed in as <strong>{displayName(phase.identity)}</strong>.
            </p>
            <p>
              Release your identity assertion to{" "}
              <code className="broker__origin">{phase.request.origin}</code>?
            </p>
            <p>
              Scopes: <code>{phase.request.scope}</code>
            </p>
            <div className="broker__actions">
              <button
                type="button"
                className="broker__btn"
                onClick={() => release(phase.request, phase.identity, true)}
              >
                Allow once and remember
              </button>
              <button
                type="button"
                className="broker__btn broker__btn--ghost"
                onClick={() => deny(phase.request)}
              >
                Deny
              </button>
            </div>
            <button
              type="button"
              className="broker__link"
              onClick={() => {
                clearSession();
                setPhase({ kind: "sign_in", request: phase.request });
              }}
            >
              Use a different account
            </button>
          </div>
        ) : null}
      </main>
    </div>
  );
}
