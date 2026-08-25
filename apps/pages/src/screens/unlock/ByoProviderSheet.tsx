/**
 * "Use your own identity provider" — BYO OIDC at registration (ADR 0055/D5).
 *
 * Two steps: name the issuer and check it (the server runs SSRF-fenced
 * discovery and, where the provider supports RFC 7591, registers a client
 * automatically), then continue with the registered provider — or, when the
 * provider doesn't self-register, paste a client ID created there, with the
 * deployment's redirect URI shown to copy.
 */

import { type FormEvent, useState } from "react";
import {
  type ByoRegistration,
  ByoError,
  registerByoProvider,
} from "../../lib/byo.js";

export const byoSheetDependencies = {
  registerByoProvider,
};

type Props = {
  disabled?: boolean;
  /** Start the brokered sign-in leg for the registered issuer. */
  onContinue: (registration: ByoRegistration) => void;
};

export function ByoProviderSheet({ disabled, onContinue }: Props) {
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [needsClient, setNeedsClient] = useState(false);
  const [registration, setRegistration] = useState<ByoRegistration | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function check(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setCopied(false);
    setBusy(true);
    try {
      const registered = await byoSheetDependencies.registerByoProvider({
        issuer: issuer.trim(),
        ...(needsClient && clientId.trim()
          ? { clientId: clientId.trim() }
          : {}),
        ...(needsClient && clientSecret ? { clientSecret } : {}),
      });
      setRegistration(registered);
      setNeedsClient(false);
    } catch (caught) {
      if (caught instanceof ByoError) {
        if (caught.code === "registration_unsupported") {
          // The provider has no RFC 7591 endpoint: open the manual client
          // fields rather than dead-ending on the message.
          setNeedsClient(true);
        }
        setError(caught.message);
      } else {
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not check that provider.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function copyRedirectUri(): Promise<void> {
    if (!registration) return;
    try {
      await navigator.clipboard.writeText(registration.redirectUri);
      setCopied(true);
    } catch {
      /* clipboard denied — the URI is on screen to select */
    }
  }

  return (
    <div className="byo">
      <form className="byo__form" onSubmit={(e) => void check(e)} noValidate>
        <div className="field">
          <label htmlFor="byo-issuer">Issuer URL</label>
          <input
            id="byo-issuer"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://auth.example.dev"
            value={issuer}
            disabled={disabled || busy}
            onChange={(event) => {
              setIssuer(event.target.value);
              setError(null);
              setRegistration(null);
            }}
          />
          <p className="hint">
            Any OpenID Connect issuer you control. Its discovery document is
            fetched over HTTPS and must name this exact issuer.
          </p>
        </div>
        {needsClient ? (
          <>
            <div className="field">
              <label htmlFor="byo-client-id">Client ID</label>
              <input
                id="byo-client-id"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={clientId}
                disabled={disabled || busy}
                onChange={(event) => setClientId(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="byo-client-secret">Client secret (optional)</label>
              <input
                id="byo-client-secret"
                type="password"
                autoComplete="off"
                placeholder="optional — only sent to your provider"
                value={clientSecret}
                disabled={disabled || busy}
                onChange={(event) => setClientSecret(event.target.value)}
              />
            </div>
          </>
        ) : null}
        <button
          type="submit"
          className="btn btn--block"
          disabled={disabled || busy || issuer.trim().length === 0}
          aria-busy={busy || undefined}
        >
          {busy
            ? "Checking provider…"
            : needsClient
              ? "Register with this client"
              : "Check provider"}
        </button>
      </form>

      {error ? (
        <p className="hint identifier__error" role="alert">
          {error}
        </p>
      ) : null}

      {registration ? (
        <div className="byo__ready">
          <div className="identifier__org">
            <strong>{registration.label}</strong>
            <span className="hint">
              OpenID Connect · discovery verified ·{" "}
              {registration.registrationSource === "dcr"
                ? "client registered automatically"
                : "using your client"}
            </span>
          </div>
          <div className="field">
            <span className="label">Redirect URI for your provider</span>
            <div className="byo__uri">
              <code>{registration.redirectUri}</code>
              <button
                type="button"
                className="icon-btn"
                aria-label="Copy redirect URI"
                onClick={() => void copyRedirectUri()}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
                  <path d="M5.5 15.5h-1a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              </button>
            </div>
            <p className="hint">
              {copied
                ? "Copied. Add it to your provider's allowed redirect URIs."
                : "Make sure your provider allows this exact redirect URI."}
            </p>
          </div>
          <p className="hint">
            Accounts from your own provider are never merged with email
            accounts — that separation is a security guarantee.
          </p>
          <button
            type="button"
            className="btn btn--primary btn--block"
            disabled={disabled || busy}
            onClick={() => onContinue(registration)}
          >
            Continue with {registration.label}
          </button>
        </div>
      ) : null}
    </div>
  );
}
