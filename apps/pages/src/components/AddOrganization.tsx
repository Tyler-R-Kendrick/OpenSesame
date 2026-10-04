/**
 * Adding an organization to the account switcher's menu.
 *
 * Looks up the tenant slug, then starts the method it advertises: an OIDC
 * round-trip run in this tab when the tenant published an issuer, and
 * otherwise — native SAML, LDAP, anything with no browser leg — the same flow
 * run for us by the Identity API (ADR 0056, D7/D8). Its state is the flow's
 * alone, so closing the menu, which unmounts this, is also what resets it.
 */

import { beginSignIn } from "@opensesame/app-core/lib/federation.js";
import {
  IdentityError,
  ensureIdentitySession,
} from "@opensesame/app-core/lib/identity.js";
import {
  type OrgAuthMethod,
  type OrgTenant,
  lookupOrgTenant,
  orgAuthUpstream,
  routeOrgMethod,
} from "@opensesame/app-core/lib/orgs.js";
import { brokeredOrgUpstream } from "@opensesame/app-core/lib/providers.js";
import { useState } from "react";
import { useLocation } from "react-router";
import { IconPlus } from "./Icons.js";

/** The lookup-then-start flow's state and the two things that drive it. */
function useAddOrganization() {
  const location = useLocation();
  const [adding, setAdding] = useState(false);
  const [slug, setSlug] = useState("");
  const [tenant, setTenant] = useState<OrgTenant | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return {
    adding,
    setAdding,
    slug,
    setSlug,
    tenant,
    setTenant,
    busy,
    error,
    setError,
    lookup,
    startMethod,
  };
}

export function AddOrganization() {
  const {
    adding,
    setAdding,
    slug,
    setSlug,
    tenant,
    setTenant,
    busy,
    error,
    setError,
    lookup,
    startMethod,
  } = useAddOrganization();

  return (
    <>
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
          <p className="account-switcher__tenant-name">{tenant.displayName}</p>
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
    </>
  );
}
