import {
  type LocalAuthorizationRequest,
  parseLocalAuthorizationRequest,
} from "@opensesame/static-auth";
import { useEffect, useMemo, useRef } from "react";
import { Link, useLocation } from "react-router";
import { firstControl, keyboardIsIdle, landFocus } from "../lib/focus.js";
import { useVaultStore } from "../lib/vault/hooks.js";
import { useLocalConsent } from "./useLocalConsent.js";

export function LocalAuthorize() {
  const { search } = useLocation();
  const tomb = useVaultStore().activeTomb();
  const request = useMemo(() => {
    try {
      return parseLocalAuthorizationRequest(search);
    } catch {
      return null;
    }
  }, [search]);
  if (!request)
    return (
      <section className="panel" aria-label="Application sign-in">
        <div className="panel__head">
          <h1>Invalid application request</h1>
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
    <LocalConsent key={`${tomb}:${search}`} tomb={tomb} request={request} />
  );
}

function LocalConsent({
  tomb,
  request,
}: { tomb: string; request: LocalAuthorizationRequest }) {
  const model = useLocalConsent(tomb, request);
  return (
    <section
      className="panel"
      aria-label="Application sign-in"
      aria-busy={model.busy}
    >
      <div className="panel__head">
        <h1>
          {request.agent ? "Authorize agent access to" : "Sign in to"}{" "}
          {model.application || "an application"}
        </h1>
      </div>
      <div className="panel__body">
        <p>
          Requesting site:{" "}
          <code className="identity-ref">
            {new URL(request.redirectUri).origin}
          </code>
        </p>
        <details>
          <summary>Exact callback address</summary>
          <p className="identity-ref">{request.redirectUri}</p>
        </details>
        {model.agent ? (
          <div>
            <p>
              Agent requesting access: <strong>{model.agent.name}</strong>
            </p>
            <details>
              <summary>Agent identity and enrolled key</summary>
              <p className="identity-ref">{model.agent.id}</p>
              <p className="identity-ref">{model.agentKeyId}</p>
            </details>
          </div>
        ) : null}
        <p>
          Requested permissions: <code>{request.scopes.join(" ")}</code>
        </p>
        <p className="hint">
          {request.agent
            ? "This authorizes the named agent, not your identity. Access ends when either session expires or is revoked. No vault contents or upstream token are shared."
            : "This shares your local subject identifier, not vault contents or an upstream token. Application resource access still requires its own policy."}
        </p>
        {model.error ? (
          <p role="alert" className="note note--err">
            {model.error}
          </p>
        ) : null}
        {!model.loaded && !model.error ? (
          <output>Reading application registration…</output>
        ) : null}
        <ConsentControls model={model} />
      </div>
    </section>
  );
}

function ConsentControls({
  model,
}: { model: ReturnType<typeof useLocalConsent> }) {
  const root = useRef<HTMLDivElement>(null);
  const { session, busy, loaded, status } = model;
  useEffect(() => {
    if (loaded && !busy && keyboardIsIdle())
      landFocus(firstControl(root.current));
  });
  const terminal =
    status === "closed" || status === "active" || status === "approved";
  return (
    <div ref={root}>
      {loaded && !terminal ? <ConsentForm model={model} /> : null}
      <p className="hint">
        <output aria-label="Application connection status">
          {status === "active"
            ? "Application connected. Keep this window open while using it."
            : status === "closed"
              ? "Application connection ended. Start a new sign-in from the application."
              : status === "approved"
                ? "Finishing application sign-in…"
                : status === "waiting"
                  ? model.agent
                    ? "Waiting for the application's agent proof…"
                    : "Waiting for the application window…"
                  : session
                    ? "Passkey verified. Review the site and permissions before allowing access."
                    : "Application connected. Verify your local identity to continue."}
        </output>
      </p>
      {status === "active" ? (
        <div className="actions">
          <button type="button" className="btn" onClick={model.close}>
            End application session
          </button>
        </div>
      ) : null}
      {status === "closed" ? (
        <Link to="/identity?view=applications">Manage applications</Link>
      ) : null}
    </div>
  );
}

function ConsentForm({ model }: { model: ReturnType<typeof useLocalConsent> }) {
  const { session, busy, status } = model;
  return (
    <>
      <div className="field">
        <label className="label" htmlFor="local-consent-person">
          {model.agent ? "Approving person" : "Person"}
        </label>
        <select
          id="local-consent-person"
          value={model.person}
          disabled={busy || session !== null}
          onChange={(event) => model.setPerson(event.target.value)}
        >
          <option value="">Choose a local person</option>
          {model.people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
      </div>
      {model.people.length === 0 ? (
        <p>
          {model.agent
            ? "No enabled owners or admins belong to this application's organization. Assign membership in Identity before approving agent access."
            : "No enabled people belong to this application's organization. Assign membership in Identity before signing in."}
        </p>
      ) : null}
      <div className="actions">
        {session ? (
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || status !== "connected"}
            onClick={() => void model.run(true)}
          >
            {model.agent ? "Allow agent access" : "Allow application"}
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={busy || !model.person || status !== "connected"}
            onClick={() => void model.run(false)}
          >
            {busy ? "Verifying passkey…" : "Verify with passkey"}
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={model.close}
        >
          Deny
        </button>
      </div>
    </>
  );
}
