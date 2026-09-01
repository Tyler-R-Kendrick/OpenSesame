/**
 * Federated sign-in, on both screens a person can land on.
 *
 * One decision per screen, literally: the panel is a stage machine. The hub
 * leads with a single-row social bar — one icon button per provider (official
 * brand marks, no text), a globe for bring-your-own OIDC, and a ⋯ that opens
 * the remaining roads (overflow providers, magic link) as a dropdown. Guest
 * stays a full-size button of its own (the most common road in, first run
 * only). Below the bar sits the one "Email or organization" field, focused on
 * arrival so typing starts immediately. Nothing renders beside the step being
 * taken.
 *
 * Two placements, because a returning visitor is not a new one:
 *
 *  - `primary` — first run. Identity comes before sealing (ADR 0033 §4), so
 *    this panel *is* the screen, and it owns the two roads out of it: sign in,
 *    or seal a local-only vault instead.
 *  - `secondary` — a vault already exists on this device, and this panel is
 *    the Unlock screen's "Sign in" tab. The vault key still comes from the
 *    passkey, PIN, or password on the Unlock tab, so signing in here attaches
 *    an account rather than opening anything — `adoptFederatedIdentity` says
 *    exactly that when it comes back to a locked vault. The two roads that
 *    would make a second vault beside the existing one — "Use without an
 *    account" and guest — are not offered; a live session gets a Sign out
 *    instead.
 *
 * Every federated entry ends in a navigation, so success never returns here —
 * only a failure gets to clear `busy` and say why, in plain words.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  IconDots,
  IconLogin,
  IconSite,
  IconUser,
} from "../../components/Icons.js";
import type { ByoRegistration } from "../../lib/byo.js";
import { describeFederationError } from "../../lib/federation-copy.js";
import {
  TRUSTED_UPSTREAMS,
  beginSignIn,
  defaultUpstream,
  operatorUpstream,
} from "../../lib/federation.js";
import { continueAsGuest } from "../../lib/guest-auth.js";
import {
  endSession,
  identityBase,
  useIdentitySession,
} from "../../lib/identity.js";
import {
  type OrgAuthMethod,
  type OrgTenant,
  orgAuthUpstream,
  routeOrgMethod,
} from "../../lib/orgs.js";
import {
  type FederatedProviderSummary,
  brokeredByoUpstream,
  brokeredOrgUpstream,
  brokeredRealmUpstream,
  brokeredUpstream,
  requestEmailMagicLink,
} from "../../lib/providers.js";
import { signInMethods } from "../../lib/settings.js";
import { ByoProviderSheet } from "./ByoProviderSheet.js";
import { IdentifierField } from "./IdentifierField.js";
import { brandFor } from "./ProviderBrand.js";

type Props =
  | {
      /** First run: this panel is the screen. */
      placement: "primary";
      /** The deployment's provider catalog; empty falls back to the default upstream. */
      providers: FederatedProviderSummary[];
      /** Switch to the local-only seal form — no account, no sync, no recovery. */
      onUseLocalOnly: () => void;
    }
  | {
      /** A vault already exists here: the unlock form is the screen. */
      placement: "secondary";
      providers: FederatedProviderSummary[];
    };

/** Which single step of the ceremony is on screen. */
type Stage = "hub" | "magic-link" | "byo";

/**
 * How many providers get an icon button in the social bar before the rest
 * move into the ⋯ menu. The bar holds this many plus the BYO globe and the ⋯
 * itself, in one row, at the card's narrowest width.
 */
const VISIBLE_PROVIDERS = 4;

/** What a provider's button announces — bar buttons are icon-only. */
function providerLabel(provider: FederatedProviderSummary): string {
  return `Continue with ${brandFor(provider.id)?.label ?? provider.label}`;
}

export function SignInPanel(props: Props) {
  const { placement, providers } = props;
  const firstRun = placement === "primary";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("hub");
  /** True while the identifier field is showing a result step of its own. */
  const [identifierEngaged, setIdentifierEngaged] = useState(false);
  const [linkEmail, setLinkEmail] = useState("");
  const [linkSent, setLinkSent] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const session = useIdentitySession();
  // Reads location.hostname, so it must be resolved at render, not at import:
  // loopback deployments get the local mock IdP, everything else the broker.
  const upstream = defaultUpstream();
  // Broker disclosures the branded buttons owe the reader (e.g. Google via
  // shoo.dev) — under the buttons, never in the label.
  const brokerNotes = [
    ...new Set(
      providers
        .map((provider) => brandFor(provider.id)?.note)
        .filter((note): note is string => Boolean(note)),
    ),
  ];
  // The loopback mock IdP is development plumbing, never a sign-in road: the
  // catalog's "mock" entry is filtered out before anything renders, and a mock
  // default upstream means there is NO fallback button at all.
  const catalogProviders = providers.filter(
    (provider) => provider.id !== "mock",
  );
  const visibleProviders = catalogProviders.slice(0, VISIBLE_PROVIDERS);
  const overflowProviders = catalogProviders.slice(VISIBLE_PROVIDERS);
  const upstreamBrand = brandFor(upstream.id);
  /**
   * What first-run setup allowed, and nothing else (ADR 0078 §3).
   *
   * The screen used to offer every road it could name — the compiled broker, a
   * bring-your-own globe, a magic link, guest — whether or not the deployment
   * had anything behind them. Most of those need an Identity API, so on a
   * deployment without one they were buttons that could only fail. Setup is
   * the allowlist now: these two lines decide the whole bar.
   */
  const methods = signInMethods();
  /**
   * The service roads — org SSO, SAML, magic link, BYO — need one. Guest does
   * NOT: `continueAsGuest` seals a local vault and merely *offers* a claim
   * once Identity is reachable, so the guest road is never gated on this (see
   * AGENTS.md §5 — the guest/anonymous flow must not be removed or gated).
   */
  const hasIdentityService = identityBase().trim().length > 0;
  const fallbackUpstream =
    methods.builtin && upstream.id !== "mock" ? upstream : null;

  // The ⋯ menu closes on Escape and on any press outside it — the two ways a
  // person says "not that, actually" without picking anything.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target)
      ) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

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
    // No returnTo: the return screen already lands on the app root, and an
    // explicit one would read as "resume a task", which would skip opening
    // the vault for a first-run sign-in.
    startFederated(() =>
      direct
        ? beginSignIn(direct)
        : beginSignIn(brokeredUpstream(provider), {
            providerHint: provider.id,
          }),
    );
  }

  function startOrgMethod(tenant: OrgTenant, method: OrgAuthMethod): void {
    const route = routeOrgMethod(method);
    startFederated(() =>
      route.via === "brokered"
        ? // Native SAML and LDAP have no browser leg: the Identity API runs
          // the whole ceremony and hands this tab a session to adopt.
          beginSignIn(brokeredOrgUpstream(tenant))
        : beginSignIn(orgAuthUpstream(tenant, method), {
            orgSlug: tenant.slug,
            orgMethod: route.kind,
          }),
    );
  }

  function continueWithDomain(domain: string): void {
    // Routing only (D12/T28): the domain goes to the login page as a standard
    // `login_hint`; the address it came from never leaves the identifier field.
    startFederated(() =>
      beginSignIn(brokeredRealmUpstream(), {
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

  function backButton(label: string, to: Stage): ReactElement {
    return (
      <button
        type="button"
        className="unlock__switch signin__back"
        disabled={busy}
        onClick={() => {
          setError(null);
          setStage(to);
        }}
      >
        ‹ {label}
      </button>
    );
  }

  const errorNote = error ? (
    <p className="note note--err" role="alert">
      <span>{error}</span>
    </p>
  ) : null;

  if (stage === "magic-link") {
    return (
      <div className="signin">
        {backButton("Back to sign-in", "hub")}
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
          {linkSent ? (
            <p className="hint">Check your email for a sign-in link.</p>
          ) : null}
          {linkError ? (
            <p className="hint identifier__error" role="alert">
              {linkError}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  if (stage === "byo") {
    return (
      <div className="signin">
        {backButton("Back to sign-in", "hub")}
        <ByoProviderSheet disabled={busy} onContinue={startByo} />
        {errorNote}
      </div>
    );
  }

  return (
    <div className="signin">
      {identifierEngaged ? null : (
        <>
          {/* The anonymous road out of this screen, in the card's top-right
              corner where a "skip" always lives. First run only — beside an
              existing vault a guest principal would seal a second one. Never
              gated on an Identity API: guest works fully offline. */}
          {firstRun ? (
            <button
              type="button"
              className="unlock__switch signin__skip"
              aria-label="Skip sign-in and continue as guest"
              disabled={busy}
              onClick={startGuest}
            >
              Skip
            </button>
          ) : null}
          {!firstRun && session ? (
            <p className="hint signin__session">
              <button
                type="button"
                className="unlock__switch"
                disabled={busy}
                onClick={() => endSession()}
              >
                Sign out
              </button>
            </p>
          ) : null}
          <div className="signin__providers">
            {/* Social sign-in is the default road: one row of official brand
                marks, no text — the accessible name still says which is which.
                An existing upstream session (a Google profile already
                authorized in this browser) is detected by the provider itself
                once the leg starts. */}
            <div className="signin__bar">
              {/* The operator's own providers, in the order they added them,
                  wearing their own marks where an official one exists. */}
              {methods.providers.map((idp) => {
                const brand = brandFor(idp.providerId);
                return (
                  <button
                    key={idp.issuer}
                    type="button"
                    className={`btn signin__social${
                      brand ? ` ${brand.className}` : ""
                    }`}
                    aria-label={`Continue with ${idp.label}`}
                    title={`Continue with ${idp.label}`}
                    disabled={busy}
                    onClick={() =>
                      startFederated(() => beginSignIn(operatorUpstream(idp)))
                    }
                  >
                    {brand ? <brand.Icon size={20} /> : <IconSite size={20} />}
                  </button>
                );
              })}
              {catalogProviders.length > 0 ? (
                visibleProviders.map((provider) => {
                  const brand = brandFor(provider.id);
                  return (
                    <button
                      key={provider.id}
                      type="button"
                      className={`btn signin__social${
                        brand ? ` ${brand.className}` : ""
                      }`}
                      aria-label={providerLabel(provider)}
                      title={providerLabel(provider)}
                      disabled={busy}
                      onClick={() => startProvider(provider)}
                    >
                      {brand ? (
                        <brand.Icon size={20} />
                      ) : (
                        <IconLogin size={20} />
                      )}
                    </button>
                  );
                })
              ) : fallbackUpstream ? (
                <button
                  type="button"
                  className={`btn signin__social${
                    upstreamBrand ? ` ${upstreamBrand.className}` : ""
                  }`}
                  aria-label={`Continue with ${upstreamBrand?.label ?? fallbackUpstream.accountKind}`}
                  title={`Continue with ${upstreamBrand?.label ?? fallbackUpstream.accountKind}`}
                  disabled={busy}
                  onClick={() =>
                    startFederated(() => beginSignIn(fallbackUpstream))
                  }
                >
                  {upstreamBrand ? (
                    <upstreamBrand.Icon size={20} />
                  ) : (
                    <IconLogin size={20} />
                  )}
                </button>
              ) : null}
              {/* BYO OIDC as an icon in the same row: the globe is the
                  conventional mark for "my own identity provider". It
                  registers through an identity service, so it appears only
                  where there is one — a globe that can only fail is exactly
                  the dead end setup exists to remove. */}
              {hasIdentityService ? (
                <button
                  type="button"
                  className="btn signin__social"
                  aria-label="Continue with your IdP"
                  title="Continue with your IdP"
                  disabled={busy}
                  onClick={() => setStage("byo")}
                >
                  <IconSite size={20} />
                </button>
              ) : null}
              {overflowProviders.length > 0 || hasIdentityService ? (
                <div className="signin__menuwrap" ref={menuRef}>
                  <button
                    type="button"
                    className="btn signin__social"
                    aria-label="More sign-in options"
                    title="More sign-in options"
                    aria-expanded={menuOpen}
                    disabled={busy}
                    onClick={() => setMenuOpen((open) => !open)}
                  >
                    <IconDots size={20} />
                  </button>
                  {menuOpen ? (
                    <div className="signin__menu">
                      {overflowProviders.map((provider) => {
                        const brand = brandFor(provider.id);
                        return (
                          <button
                            key={provider.id}
                            type="button"
                            className="signin__menu-item"
                            disabled={busy}
                            onClick={() => {
                              setMenuOpen(false);
                              startProvider(provider);
                            }}
                          >
                            {brand ? (
                              <brand.Icon size={18} />
                            ) : (
                              <IconLogin size={18} />
                            )}
                            {providerLabel(provider)}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        className="signin__menu-item"
                        disabled={busy}
                        onClick={() => {
                          setMenuOpen(false);
                          setStage("magic-link");
                        }}
                      >
                        <IconLogin size={18} />
                        Email me a sign-in link
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            {/* Guest is the most common road in, so it is a full-size button
                beside the social bar — never a footnote. First run only:
                beside an existing vault a guest principal would seal a
                second one. Never gated on an Identity API — `continueAsGuest`
                seals a local vault and works with no service at all. */}
            {firstRun ? (
              <button
                type="button"
                className="btn btn--block signin__provider"
                disabled={busy}
                onClick={startGuest}
              >
                <IconUser size={18} />
                Continue as guest
              </button>
            ) : null}
            {brokerNotes.map((note) => (
              <p className="hint signin__provider-note" key={note}>
                {note}
              </p>
            ))}
          </div>

          {/* The identifier field looks an organisation up and routes to its
              SSO, SAML or LDAP — all of which the Identity API runs. Without
              one there is nothing to look anybody up in. */}
          {hasIdentityService ? (
            <div className="signin__divider" aria-hidden="true">
              or
            </div>
          ) : null}
        </>
      )}

      {hasIdentityService ? (
        <IdentifierField
          disabled={busy}
          autoFocus
          onStartOrgMethod={startOrgMethod}
          onContinueWithDomain={continueWithDomain}
          onEngagedChange={setIdentifierEngaged}
        />
      ) : null}

      {errorNote}

      {identifierEngaged ? null : (
        <div className="signin__more">
          {props.placement === "primary" ? (
            <button
              type="button"
              className="unlock__switch"
              disabled={busy}
              onClick={props.onUseLocalOnly}
            >
              Use without an account
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
