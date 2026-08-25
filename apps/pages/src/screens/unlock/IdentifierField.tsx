/**
 * The one "Email or organization" field (D12/T28).
 *
 * Replaces the slug field + work-email field pair: a work email resolves the
 * organization by its DOMAIN (the local part never leaves this device), a
 * slug resolves it directly, and a personal email falls back to the magic
 * link — which is the one path entitled to the full address (D18). Lookups
 * run on explicit continue, never per keystroke.
 */

import { type FormEvent, useState } from "react";
import { classifyIdentifier } from "../../lib/identifier.js";
import {
  type OrgAuthMethod,
  type OrgTenant,
  lookupOrgByDomain,
  lookupOrgTenant,
} from "../../lib/orgs.js";
import { requestEmailMagicLink } from "../../lib/providers.js";

export const identifierFieldDependencies = {
  lookupOrgTenant,
  lookupOrgByDomain,
  requestEmailMagicLink,
};

/** The realm route's uniform words — anti-enumeration, so this is all we know. */
const NO_ORG_MESSAGE = "No organization uses that email domain.";

type Props = {
  disabled?: boolean;
  /** Start sign-in against a resolved organization method. */
  onStartOrgMethod: (tenant: OrgTenant, method: OrgAuthMethod) => void;
  /** Optional escape hatch: hand the domain to the hosted page's realm router. */
  onContinueWithDomain?: (domain: string) => void;
};

export function IdentifierField({
  disabled,
  onStartOrgMethod,
  onContinueWithDomain,
}: Props) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tenant, setTenant] = useState<OrgTenant | null>(null);
  /** Set when an email resolved to no org — the magic-link fallback owns it. */
  const [fallbackEmail, setFallbackEmail] = useState<string | null>(null);
  const [fallbackDomain, setFallbackDomain] = useState<string | null>(null);
  const [linkSent, setLinkSent] = useState(false);

  function reset(): void {
    setError(null);
    setTenant(null);
    setFallbackEmail(null);
    setFallbackDomain(null);
    setLinkSent(false);
  }

  async function resolve(event: FormEvent): Promise<void> {
    event.preventDefault();
    reset();
    const parsed = classifyIdentifier(value);
    if (parsed.kind === "unknown") {
      setError(
        "Enter a work email like you@acme.com, or an organization name like acme-corp.",
      );
      return;
    }
    setBusy(true);
    try {
      if (parsed.kind === "slug") {
        setTenant(
          await identifierFieldDependencies.lookupOrgTenant(parsed.slug),
        );
      } else {
        const found = await identifierFieldDependencies.lookupOrgByDomain(
          parsed.domain,
        );
        if (found) {
          setTenant(found);
        } else {
          setFallbackEmail(parsed.email);
          setFallbackDomain(parsed.domain);
        }
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not look that up. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function sendLink(): Promise<void> {
    if (!fallbackEmail) return;
    setError(null);
    setBusy(true);
    try {
      await identifierFieldDependencies.requestEmailMagicLink(fallbackEmail);
      setLinkSent(true);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not send the sign-in link.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="identifier">
      <form className="identifier__form" onSubmit={(e) => void resolve(e)}>
        <label className="label" htmlFor="identifier-input">
          Email or organization
        </label>
        <div className="identifier__row">
          <input
            id="identifier-input"
            type="text"
            autoComplete="username"
            placeholder="you@acme.com  ·  acme-corp"
            value={value}
            disabled={disabled || busy}
            onChange={(event) => {
              setValue(event.target.value);
              if (error) setError(null);
            }}
          />
          <button
            type="submit"
            className="btn"
            disabled={disabled || busy || !value.trim()}
            aria-busy={busy || undefined}
          >
            Continue
          </button>
        </div>
        <p className="hint">
          A work email finds your organization's sign-in; only the domain leaves
          this device. A personal email gets a one-time link.
        </p>
      </form>

      {error ? (
        <p className="hint identifier__error" role="alert">
          {error}
        </p>
      ) : null}

      {tenant ? (
        <div className="identifier__resolved">
          <div className="identifier__org">
            <strong>{tenant.displayName}</strong>
            <span className="hint">{tenant.slug} · verified organization</span>
          </div>
          {tenant.authMethods.length === 0 ? (
            <p className="hint">
              This organization has no sign-in methods configured yet. Ask its
              owner to finish setup.
            </p>
          ) : (
            <div className="identifier__methods">
              {tenant.authMethods.map((method, index) => (
                <button
                  key={method.kind}
                  type="button"
                  className={
                    index === 0
                      ? "btn btn--primary btn--block"
                      : "btn btn--block"
                  }
                  disabled={disabled || busy}
                  onClick={() => onStartOrgMethod(tenant, method)}
                >
                  Continue with {method.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {fallbackEmail && !linkSent ? (
        <div className="identifier__fallback">
          <p className="hint">
            {NO_ORG_MESSAGE} That's fine — you can still sign in with this
            address.
          </p>
          <button
            type="button"
            className="btn btn--primary btn--block"
            disabled={disabled || busy}
            onClick={() => void sendLink()}
          >
            Email me a sign-in link
          </button>
          {onContinueWithDomain && fallbackDomain ? (
            <button
              type="button"
              className="btn btn--ghost btn--block"
              disabled={disabled || busy}
              onClick={() => onContinueWithDomain(fallbackDomain)}
            >
              Continue on the hosted sign-in page instead
            </button>
          ) : null}
        </div>
      ) : null}

      {linkSent ? (
        <output className="note note--ok identifier__sent">
          Check your inbox — the link signs this device in.
        </output>
      ) : null}
    </div>
  );
}
