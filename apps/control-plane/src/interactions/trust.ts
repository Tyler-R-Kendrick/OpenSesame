import type { ByoUpstream, Organization } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import {
  type ProviderDescriptor,
  normalizeIssuer,
  providerByIssuer,
} from "./registry.js";

/**
 * One trust fence for every federated leg (ADR 0055).
 *
 * Before this module the question "may we federate to this issuer?" was a
 * membership test against one CSV. It now has three legitimate answers, in a
 * fixed order of authority:
 *
 * 1. the static registry — providers the operator configured, plus issuers
 *    allowlisted without a registry entry (still first-class);
 * 2. a durable bring-your-own upstream record the visitor registered, and only
 *    while it is `active`;
 * 3. an organization's configured SSO or SAML issuer.
 *
 * Anything else is `undefined`, which callers map to `untrusted_issuer`. The
 * order matters: an operator-configured provider must never be shadowed by a
 * BYO record or an org row naming the same issuer, because the operator's
 * entry is the one carrying the client credentials.
 */

/** The visitor-registered upstream record (C6), re-exported for callers. */
export type { ByoUpstream };

export type TrustResolution =
  | { source: "static"; provider: ProviderDescriptor }
  | { source: "byo"; record: ByoUpstream }
  | {
      source: "org";
      organizationId: string;
      issuer: string;
      method: "sso" | "saml";
    };

/** Suspended and deleted tenants sign nobody in. */
function organizationSignsIn(organization: Organization): boolean {
  return organization.state !== "deleted" && organization.state !== "suspended";
}

async function resolveByoUpstream(
  ctx: AppContext,
  issuer: string,
): Promise<ByoUpstream | undefined> {
  const record = await ctx.repos.byoUpstreams.findByIssuer(issuer);
  // A disabled record is a decision an operator made (D14); it must not
  // resolve, and it must not fall through to some other source either.
  return record && record.state === "active" ? record : undefined;
}

async function resolveOrganizationIssuer(
  ctx: AppContext,
  issuer: string,
): Promise<TrustResolution | undefined> {
  const organization = await ctx.stores.organizations.findByIssuer(issuer);
  if (!organization || !organizationSignsIn(organization)) return undefined;
  const method =
    normalizeIssuer(organization.ssoIssuer ?? "") === issuer ? "sso" : "saml";
  return {
    source: "org",
    organizationId: organization.id,
    issuer,
    method,
  };
}

/**
 * Resolve an issuer to the authority that vouches for it, or `undefined` when
 * nothing does. Issuers are compared trailing-slash-normalized, because
 * `https://idp.example` and `https://idp.example/` are the same issuer and a
 * fence that disagrees is a fence with a hole in it.
 */
export async function resolveTrustedIssuer(
  ctx: AppContext,
  issuer: string,
): Promise<TrustResolution | undefined> {
  const normalized = normalizeIssuer(issuer);
  if (!normalized) return undefined;

  const provider = providerByIssuer(ctx.config, normalized);
  if (provider) return { source: "static", provider };

  const record = await resolveByoUpstream(ctx, normalized);
  if (record) return { source: "byo", record };

  return resolveOrganizationIssuer(ctx, normalized);
}
