/**
 * Account switcher — guest / personal plus org profiles on this principal.
 *
 * Adding an organization looks up the tenant slug, then starts SSO or SAML
 * (OIDC-brokered) against the issuer Identity advertised. Guests included.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { useLocation } from "react-router";
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
  setActiveOrgProfileId,
  subscribeOrgProfile,
} from "../lib/orgs.js";
import { IconCheck, IconPlus, IconUser } from "./Icons.js";

function guestLabel(hasSession: boolean, assurance?: string): string {
  if (!hasSession) return "Guest";
  if (assurance === "provisional" || !assurance) return "Guest";
  return "Account";
}

function AccountSwitcherDefault() {
  const location = useLocation();
  const session = useIdentitySession();
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
  const label = activeOrg?.displayName ?? guestLabel(Boolean(session));

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
      await beginSignIn(orgAuthUpstream(tenant, method), {
        orgSlug: tenant.slug,
        orgMethod: method.kind,
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
        type="button"
        className="account-switcher__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <IconUser size={15} />
        <span className="account-switcher__name">{label}</span>
        <span className="account-switcher__caret" aria-hidden="true">
          ▾
        </span>
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
