/**
 * Account switcher — who this device is signed in as, the org profiles on
 * that principal, and the roads out.
 *
 * The `who@` segment of the prompt opens it. At the top it names the account
 * the way the unlock screen does (`lib/account.ts`); in the middle are the
 * profiles it always had; at the bottom the three exits the shell never
 * offered: attach another account, switch to a different one, sign out. All
 * three land on the unlock screen's Sign in tab, the one surface that offers
 * every configured way in (`lib/session-exit.ts`).
 *
 * Adding an organization looks up the tenant slug, then starts the method it
 * advertises: an OIDC round-trip run in this tab when the tenant published an
 * issuer, and otherwise — native SAML, LDAP, anything with no browser leg —
 * the same flow run for us by the Identity API (ADR 0056, D7/D8).
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { useLocation } from "react-router";
import { useAccount } from "../lib/account.js";
import { beginSignIn } from "../lib/federation.js";
import {
  IdentityError,
  ensureIdentitySession,
  useIdentitySession,
} from "../lib/identity.js";
import {
  GUEST_PROFILE_ID,
  type OrgAuthMethod,
  type OrgMembership,
  type OrgTenant,
  activeOrgProfileId,
  listOrgMemberships,
  lookupOrgTenant,
  orgAuthUpstream,
  routeOrgMethod,
  setActiveOrgProfileId,
  subscribeOrgProfile,
} from "../lib/orgs.js";
import { brokeredOrgUpstream } from "../lib/providers.js";
import { attachAccount, signOut, switchAccount } from "../lib/session-exit.js";
import { brandFor } from "../screens/unlock/ProviderBrand.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { IconCheck, IconPlus, IconUser } from "./Icons.js";

function guestLabel(hasSession: boolean, assurance?: string): string {
  if (!hasSession) return "guest";
  if (assurance === "provisional" || !assurance) return "guest";
  return "account";
}

function AccountSwitcherDefault() {
  const location = useLocation();
  const session = useIdentitySession();
  const account = useAccount();
  const segRef = useGuideTarget<HTMLButtonElement>("shell.account");
  const activeId = useSyncExternalStore(
    subscribeOrgProfile,
    activeOrgProfileId,
  );
  const [open, setOpen] = useState(false);
  const [memberships, setMemberships] = useState<OrgMembership[]>([]);
  const [adding, setAdding] = useState(false);
  const [slug, setSlug] = useState("");
  const [tenant, setTenant] = useState<OrgTenant | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session || !open) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await listOrgMemberships();
        if (!cancelled) setMemberships(next);
      } catch {
        if (!cancelled) setMemberships([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, open]);

  const activeOrg = memberships.find((org) => org.id === activeId);
  // The prompt's first segment: the org profile when one is active, else the
  // account — the person's name where the assertion carries one, otherwise
  // the provider's account ("Google account"), and "guest" for a provisional
  // principal nobody vouches for. On a deployment with no Identity API the
  // broker's assertion is the whole identity (ADR 0090), so it is never
  // called a guest.
  const label =
    activeOrg?.displayName ??
    (account && !account.guest ? account.name : guestLabel(Boolean(session)));
  const brand = account?.providerId ? brandFor(account.providerId) : null;

  function close(): void {
    setOpen(false);
    setAdding(false);
    setSlug("");
    setTenant(null);
    setError(null);
    setBusy(false);
  }

  function select(id: string): void {
    setActiveOrgProfileId(id);
    close();
  }

  async function lookup(): Promise<void> {
    setBusy(true);
    setError(null);
    setTenant(null);
    try {
      setTenant(await lookupOrgTenant(slug));
    } catch (cause) {
      setError(
        cause instanceof IdentityError && cause.status === 404
          ? "No organization uses that slug."
          : cause instanceof Error
            ? cause.message
            : "Could not look up that organization.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function startMethod(method: OrgAuthMethod): Promise<void> {
    if (!tenant) return;
    setBusy(true);
    setError(null);
    try {
      await ensureIdentitySession();
      const route = routeOrgMethod(method);
      if (route.via === "brokered") {
        // No issuer this browser can talk to. The Identity API runs the whole
        // leg — SAML assertion or directory bind — and the return trip carries
        // an access token this tab adopts, not an assertion it has to trust.
        await beginSignIn(brokeredOrgUpstream(tenant), {
          returnTo: location.pathname,
        });
        return;
      }
      await beginSignIn(orgAuthUpstream(tenant, method), {
        orgSlug: tenant.slug,
        orgMethod: route.kind,
        returnTo: location.pathname,
      });
    } catch (cause) {
      setBusy(false);
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not start organization sign-in.",
      );
    }
  }

  return (
    <div className="account-switcher">
      <button
        ref={segRef}
        type="button"
        className="prompt__seg"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch account"
        onClick={() => (open ? close() : setOpen(true))}
      >
        {label}
      </button>

      {open ? (
        <>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop mirrors Escape, handled on the menu */}
          <div
            className="account-switcher__backdrop"
            onClick={close}
            aria-hidden="true"
          />
          <div
            className="account-switcher__menu"
            aria-label="Accounts"
            onKeyDown={(event) => {
              if (event.key === "Escape") close();
            }}
          >
            {account ? (
              <div className="account-switcher__who">
                <span className="who__mark" aria-hidden="true">
                  {brand ? <brand.Icon size={16} /> : <IconUser size={16} />}
                </span>
                <span className="who__body">
                  <span className="who__name">{account.name}</span>
                  <span className="who__sub">{account.detail}</span>
                </span>
              </div>
            ) : null}
            <p className="account-switcher__label">Accounts</p>
            <button
              type="button"
              className={`account-switcher__item${
                !activeOrg ? " is-active" : ""
              }`}
              aria-current={!activeOrg ? "true" : undefined}
              onClick={() => select(GUEST_PROFILE_ID)}
            >
              <span className="account-switcher__item-name">
                {guestLabel(Boolean(session))}
              </span>
              {!activeOrg ? <IconCheck size={14} /> : null}
            </button>
            {memberships.map((org) => (
              <button
                key={org.id}
                type="button"
                className={`account-switcher__item${
                  org.id === activeId ? " is-active" : ""
                }`}
                aria-current={org.id === activeId ? "true" : undefined}
                onClick={() => select(org.id)}
              >
                <span className="account-switcher__item-name">
                  {org.displayName}
                </span>
                {org.id === activeId ? <IconCheck size={14} /> : null}
              </button>
            ))}

            {adding ? (
              <form
                className="account-switcher__new"
                onSubmit={(event) => {
                  event.preventDefault();
                  void lookup();
                }}
              >
                <input
                  type="text"
                  value={slug}
                  placeholder="org-slug"
                  aria-label="Organization slug"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setSlug(event.target.value);
                    setTenant(null);
                    setError(null);
                  }}
                />
                <button type="submit" disabled={busy || slug.trim().length < 2}>
                  Look up
                </button>
              </form>
            ) : (
              <button
                type="button"
                className="account-switcher__add"
                onClick={() => {
                  setAdding(true);
                  setError(null);
                }}
              >
                <IconPlus size={14} />
                Add organization
              </button>
            )}

            {tenant ? (
              <div className="account-switcher__tenant">
                <p className="account-switcher__tenant-name">
                  {tenant.displayName}
                </p>
                {tenant.authMethods.length === 0 ? (
                  <p className="account-switcher__hint">
                    This organization has not configured SSO or SAML.
                  </p>
                ) : (
                  <div className="account-switcher__methods">
                    {tenant.authMethods.map((method) => (
                      <button
                        key={method.kind}
                        type="button"
                        disabled={busy}
                        onClick={() => void startMethod(method)}
                      >
                        Continue with {method.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : null}

            {error ? <p className="account-switcher__error">{error}</p> : null}

            {/* The roads out. Each one lands on the unlock screen's Sign in
                tab, which says what just happened. */}
            <div className="account-switcher__exits">
              {account && !account.guest ? (
                <button
                  type="button"
                  className="account-switcher__exit"
                  onClick={() => {
                    close();
                    attachAccount();
                  }}
                >
                  <IconPlus size={14} />
                  Add an account…
                </button>
              ) : (
                <button
                  type="button"
                  className="account-switcher__exit"
                  onClick={() => {
                    close();
                    attachAccount();
                  }}
                >
                  <IconUser size={14} />
                  Sign in…
                </button>
              )}
              {account ? (
                <>
                  <button
                    type="button"
                    className="account-switcher__exit"
                    onClick={() => {
                      close();
                      switchAccount();
                    }}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M4 8h13l-3-3M20 16H7l3 3" />
                    </svg>
                    Switch account…
                  </button>
                  <button
                    type="button"
                    className="account-switcher__exit"
                    onClick={() => {
                      close();
                      signOut();
                    }}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9" />
                    </svg>
                    Sign out
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

export const accountSwitcherSeams = {
  AccountSwitcher: AccountSwitcherDefault,
};

export function AccountSwitcher() {
  const Impl = accountSwitcherSeams.AccountSwitcher;
  return <Impl />;
}
