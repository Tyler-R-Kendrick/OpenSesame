/**
 * The federated provider catalog this deployment offers, and the brokered
 * entries that go with it (C11, D7/D8/D12/D18).
 *
 * Two kinds of sign-in reach this static app:
 *
 *  - **Browser-capable** upstreams (`browserCapable: true`) serve CORS on their
 *    token endpoint, so this tab can run the whole code flow itself — that is
 *    the leg `federation.ts` has always run against Shoo and the reference IdP.
 *  - **Everything else** — real Google, Microsoft, GitHub, Apple, a BYO issuer,
 *    native SAML, LDAP — cannot be spoken from a browser at all. Those run the
 *    origin-profile code flow against the Identity API itself, which runs the
 *    upstream leg server-side and hands this tab an access token to adopt
 *    (C13). `apps/example-static-rp` is the proof that a site with no server
 *    can do exactly this.
 *
 * Nothing here is trusted on the strength of being in the list: the catalog
 * only decides which buttons appear. Trust still comes from the compiled
 * `TRUSTED_UPSTREAMS` plus the configured Identity API (`identityBase()`),
 * checked in `federation.ts` on the way back.
 */

import {
  type BoundaryValue,
  isBoolean,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type { TrustedUpstream } from "./federation.js";
import { identityBase } from "./identity.js";
import { localNetworkFetch } from "./local-network-fetch.js";

const PROVIDERS_FETCH_MS = 6000;

export type FederatedProviderSummary = {
  id: string;
  label: string;
  kind: "oidc" | "oauth2";
  browserCapable: boolean;
};

function isSummary(value: BoundaryValue): value is FederatedProviderSummary {
  if (!isJsonObject(value)) return false;
  return (
    isString(value.id) &&
    value.id.length > 0 &&
    isString(value.label) &&
    (value.kind === "oidc" || value.kind === "oauth2") &&
    isBoolean(value.browserCapable)
  );
}

/**
 * The catalog, or an empty list.
 *
 * Every failure — no Identity API configured, an unreachable one, a 404 from a
 * deployment that predates the endpoint, a body that is not the contract —
 * answers `[]`. First run must never dead-end on a catalog fetch: the caller
 * falls back to the single default upstream, which is what this screen offered
 * before there was a catalog at all.
 */
async function listFederatedProvidersDefault(): Promise<
  FederatedProviderSummary[]
> {
  const base = identityBase();
  if (!base) return [];
  try {
    const res = await localNetworkFetch(`${base}/v1/federated/providers`, {
      credentials: "omit",
      timeoutMs: PROVIDERS_FETCH_MS,
    });
    if (!res.ok) return [];
    const body: { providers?: BoundaryValue } = overlapCast(await res.json());
    const providers = body.providers;
    if (!Array.isArray(providers)) return [];
    const summaries: FederatedProviderSummary[] = [];
    for (const entry of providers) {
      // A row that is not the contract is dropped rather than rendered as a
      // button that cannot work.
      if (isSummary(entry)) summaries.push(entry);
    }
    return summaries;
  } catch {
    return [];
  }
}

/**
 * The upstream a brokered provider is started against: the Identity API, not
 * the provider. The provider is named separately, as a hint the hosted login
 * page pre-selects (`providerHint` → `kc_idp_hint` + `login_hint_provider`).
 */
export function brokeredUpstream(
  provider: FederatedProviderSummary,
): TrustedUpstream {
  return {
    id: `broker:${provider.id}`,
    issuer: identityBase(),
    displayName: provider.label,
    accountKind: provider.label,
  };
}

/**
 * The brokered upstream for an organization whose method the browser cannot
 * speak — native SAML and LDAP both run entirely server-side (D9/D17). The
 * hosted login page finishes the leg and JIT-joins the org; this tab only
 * adopts the session that comes back.
 */
export function brokeredOrgUpstream(org: {
  slug: string;
  displayName: string;
}): TrustedUpstream {
  return {
    id: `broker:org:${org.slug}`,
    issuer: identityBase(),
    displayName: org.displayName,
    accountKind: `your ${org.displayName} account`,
  };
}

/**
 * The brokered upstream for a bring-your-own issuer the visitor registered
 * (ADR 0055 / D5). BYO legs always run server-side, so the leg starts at the
 * Identity API with the registered issuer as the provider hint — the hosted
 * login page renders it as the preferred button and its trust fence
 * re-validates the issuer on the way through.
 */
export function brokeredByoUpstream(registration: {
  issuer: string;
  label: string;
}): TrustedUpstream {
  return {
    id: `broker:byo:${registration.issuer}`,
    issuer: identityBase(),
    displayName: registration.label,
    accountKind: `your ${registration.label} account`,
  };
}

/**
 * The brokered upstream for home-realm discovery: no provider, no org — the
 * hosted login page routes on the work-email domain it is handed.
 */
export function brokeredRealmUpstream(): TrustedUpstream {
  return {
    id: "broker:realm",
    issuer: identityBase(),
    displayName: "your organization",
    accountKind: "your work account",
  };
}

/**
 * The domain half of a work email, and nothing else (D12, T28).
 *
 * The local part is dropped here, in the browser, before anything can carry it:
 * home-realm discovery routes on the domain, and the address the human typed is
 * not an identifier this app is entitled to keep, send, or log. Returns "" when
 * the input is not an address — the caller says "no organization uses that
 * domain", the same answer an unknown domain gets.
 */
export function workEmailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "";
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : "";
}

/**
 * Ask the Identity API to email a magic link (C22/D18).
 *
 * Unlike the discovery field above, this address IS an identifier: verifying it
 * is the whole sign-in, and the verified address becomes an identity on the
 * principal. It is sent, never stored here.
 *
 * INTEGRATOR: the Better Auth mount (S11) serves this path. Until it lands the
 * request 404s and the caller surfaces "Email sign-in is not available".
 */
async function requestEmailMagicLinkDefault(email: string): Promise<void> {
  const base = identityBase();
  if (!base) {
    throw new Error(
      "No Identity API is configured. Set the Identity URL in Settings.",
    );
  }
  const res = await localNetworkFetch(`${base}/v1/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "omit",
    body: JSON.stringify({ email, callbackURL: location.origin }),
    timeoutMs: PROVIDERS_FETCH_MS,
  });
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? "Email sign-in is not available on this Identity API."
        : `Could not send the sign-in link (${res.status}).`,
    );
  }
}

export const providersSeams = {
  listFederatedProviders: listFederatedProvidersDefault,
  requestEmailMagicLink: requestEmailMagicLinkDefault,
};

export async function listFederatedProviders(): Promise<
  FederatedProviderSummary[]
> {
  return providersSeams.listFederatedProviders();
}

export async function requestEmailMagicLink(email: string): Promise<void> {
  return providersSeams.requestEmailMagicLink(email);
}
