/**
 * First-run sign-in — identity before vault sealing (ADR 0033 §4).
 *
 * One decision per screen: the deployment's providers up top, the one
 * "Email or organization" field under them, and everything rarer — magic
 * link, guest — behind "More options". Sealing this device is the NEXT step,
 * not a form competing with sign-in; the local-only path is an explicit
 * choice, not the default.
 *
 * Every federated entry ends in a navigation, so success never returns here —
 * only a failure gets to clear `busy` and say why, in plain words.
 */

import { useCallback, useEffect, useState } from "react";
import { describeFederationError } from "../../lib/federation-copy.js";
import {
  TRUSTED_UPSTREAMS,
  beginSignIn,
  defaultUpstream,
} from "../../lib/federation.js";
import { continueAsGuest } from "../../lib/guest-auth.js";
import {
  type OrgAuthMethod,
  type OrgTenant,
  orgAuthUpstream,
  routeOrgMethod,
} from "../../lib/orgs.js";
import type { ByoRegistration } from "../../lib/byo.js";
import {
  type FederatedProviderSummary,
  brokeredByoUpstream,
  brokeredOrgUpstream,
  brokeredRealmUpstream,
  brokeredUpstream,
  requestEmailMagicLink,
} from "../../lib/providers.js";
import { ByoProviderSheet } from "./ByoProviderSheet.js";
import { IdentifierField } from "./IdentifierField.js";

type Props = {
  /** The deployment's provider catalog; empty falls back to the default upstream. */
  providers: FederatedProviderSummary[];
  /** Switch to the local-only seal form — no account, no sync, no recovery. */
  onUseLocalOnly: () => void;
};

export function SignInPanel({ providers, onUseLocalOnly }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [byoOpen, setByoOpen] = useState(false);
  const [linkEmail, setLinkEmail] = useState("");
  const [linkSent, setLinkSent] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  // Reads location.hostname, so it must be resolved at render, not at import:
  // loopback deployments get the local mock IdP, everything else the broker.
  const upstream = defaultUpstream();

  const startFederated = useCallback((run: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    void run().catch((caught) => {
      setError(describeFederationError(caught));
      setBusy(false);
    });
  }, []);

  function startProvider(provider: FederatedProviderSummary): void {
    // A browser-capable provider is one this tab can talk to directly — and it
    // still has to be in the compiled trust list to be started that way. The
    // catalog decides which buttons exist, never which issuers are trusted.
    const direct = provider.browserCapable
      ? TRUSTED_UPSTREAMS.find(
          (upstreamEntry) => upstreamEntry.id === provider.id,
        )
      : undefined;
    startFederated(() =>
      direct
        ? beginSignIn(direct, { returnTo: "/" })
        : beginSignIn(brokeredUpstream(provider), {
            providerHint: provider.id,
            returnTo: "/",
          }),
    );
  }

  function startOrgMethod(tenant: OrgTenant, method: OrgAuthMethod): void {
    const route = routeOrgMethod(method);
    startFederated(() =>
      route.via === "brokered"
        ? // Native SAML and LDAP have no browser leg: the Identity API runs
          // the whole ceremony and hands this tab a session to adopt.
          beginSignIn(brokeredOrgUpstream(tenant), { returnTo: "/" })
        : beginSignIn(orgAuthUpstream(tenant, method), {
            orgSlug: tenant.slug,
            orgMethod: route.kind,
            returnTo: "/",
          }),
    );
  }

  function continueWithDomain(domain: string): void {
    // Routing only (D12/T28): the domain goes to the login page as a standard
    // `login_hint`; the address it came from never leaves the identifier field.
    startFederated(() =>
      beginSignIn(brokeredRealmUpstream(), {
        returnTo: "/",
        loginHint: domain,
      }),
    );
  }

  async function sendMagicLink(): Promise<void> {
    setLinkError(null);
    setBusy(true);
    try {
      // This address IS the identifier: the link proves it, and the proven
      // address becomes an identity on the principal (D18).
      await requestEmailMagicLink(linkEmail.trim());
      setLinkSent(true);
    } catch (caught) {
      setLinkError(
        caught instanceof Error
          ? caught.message
          : "Could not send the sign-in link.",
      );
    } finally {
      setBusy(false);
    }
  }

  function startByo(registration: ByoRegistration): void {
    // The BYO leg always runs server-side: sign in against the Identity API
    // with the registered issuer as the hint, which the hosted page renders
    // as the preferred button (and its trust fence re-validates).
    startFederated(() =>
      beginSignIn(brokeredByoUpstream(registration), {
        providerHint: registration.issuer,
        returnTo: "/",
      }),
    );
  }

  function startGuest(): void {
    setError(null);
    setBusy(true);
    void continueAsGuest()
      .catch((caught) => {
        setError(
          caught instanceof Error ? caught.message : "Guest login failed.",
        );
      })
      .finally(() => setBusy(false));
  }

  return (
    <div className="signin">
      <div className="signin__providers">
        {providers.length > 0 ? (
          providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              className="btn btn--block signin__provider"
              disabled={busy}
              onClick={() => startProvider(provider)}
            >
              Continue with {provider.label}
            </button>
          ))
        ) : (
          <button
            type="button"
            className="btn btn--block signin__provider"
            disabled={busy}
            onClick={() =>
              startFederated(() => beginSignIn(upstream, { returnTo: "/" }))
            }
          >
            Continue with {upstream.accountKind}
          </button>
        )}
        <p className="hint signin__provider-note">
          No passkey or password — this device opens with your account.
        </p>
      </div>

      <div className="signin__divider" aria-hidden="true">
        or
      </div>

      <IdentifierField
        disabled={busy}
        onStartOrgMethod={startOrgMethod}
        onContinueWithDomain={continueWithDomain}
      />

      {error ? (
        <p className="note note--err" role="alert">
          <span>{error}</span>
        </p>
      ) : null}

      <div className="signin__more">
        <button
          type="button"
          className="unlock__switch"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((open) => !open)}
        >
          More options
        </button>
        <button
          type="button"
          className="unlock__switch"
          disabled={busy}
          onClick={onUseLocalOnly}
        >
          Use without an account
        </button>
      </div>

      {moreOpen ? (
        <div className="signin__more-panel">
          <div className="field">
            <label htmlFor="signin-link-email">Email me a sign-in link</label>
            <div className="identifier__row">
              <input
                id="signin-link-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                value={linkEmail}
                placeholder="you@example.com"
                disabled={busy || linkSent}
                onChange={(e) => {
                  setLinkEmail(e.target.value);
                  setLinkError(null);
                }}
              />
              <button
                type="button"
                className="btn"
                disabled={busy || linkSent || linkEmail.trim().length === 0}
                onClick={() => void sendMagicLink()}
              >
                {linkSent ? "Sent" : "Send link"}
              </button>
            </div>
            <p className="hint">Passwordless. Works anywhere your inbox does.</p>
            {linkSent ? (
              <p className="hint">
                Check your email for a sign-in link. It signs you in on this
                device.
              </p>
            ) : null}
            {linkError ? (
              <p className="hint identifier__error" role="alert">
                {linkError}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className="unlock__switch"
            aria-expanded={byoOpen}
            disabled={busy}
            onClick={() => setByoOpen((open) => !open)}
          >
            Use your own identity provider
          </button>
          {byoOpen ? (
            <ByoProviderSheet disabled={busy} onContinue={startByo} />
          ) : null}
          <button
            type="button"
            className="unlock__switch"
            disabled={busy}
            onClick={startGuest}
          >
            Continue as guest — nothing leaves this device
          </button>
        </div>
      ) : null}
    </div>
  );
}
