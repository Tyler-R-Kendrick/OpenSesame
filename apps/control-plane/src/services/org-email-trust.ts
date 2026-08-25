import type { AppContext } from "../context.js";

/**
 * When an address an organization asserted counts as verified (ADR 0057).
 *
 * Two of the admission legs learn an email from a party the *organization*
 * configured rather than from the address's own provider: an LDAP directory
 * returns a `mail` attribute, and a SAML assertion carries an email attribute.
 * Neither protocol has anything corresponding to OIDC's `email_verified`, so
 * neither can answer "did anyone check this?" on its own.
 *
 * What they do have is administrative provenance. The address is assigned by
 * the tenant's own directory or IdP, not typed by the person signing in, which
 * is exactly the property the verified-email policy wants. The gap is that an
 * organization owner configures that directory, and an owner who could assert
 * `someone-else@gmail.com` as verified would be able to walk onto that
 * person's principal — the whole failure mode ADR 0057 exists to prevent.
 *
 * So the address counts as verified only for a domain the organization has
 * *proved it controls*, through the DNS-TXT verification the home-realm
 * discovery surface already requires. An owner asserting an address in a
 * domain they demonstrably run is asserting something about their own
 * namespace; an owner asserting anything else is asserting nothing. Anything
 * that does not pass is still carried as a display hint and joins nothing.
 *
 * Shared by both legs rather than copied into each, because the two must not
 * drift: the day one of them accepts a domain the other refuses is the day the
 * weaker one becomes the way in.
 */
export async function organizationAssertedEmailIsVerified(
  ctx: AppContext,
  organizationId: string,
  email: string | undefined,
): Promise<boolean> {
  const domain = email?.split("@")[1]?.trim().toLowerCase();
  if (!domain) return false;
  const claimed =
    await ctx.stores.orgFederation.emailDomains.findVerified(domain);
  // Verified *by this organization*. A domain another tenant proved says
  // nothing about what this one may assert, and treating it as sufficient
  // would let any tenant borrow another's proof.
  return claimed?.organizationId === organizationId;
}
