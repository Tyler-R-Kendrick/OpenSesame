/**
 * Enterprise SSO presets for the Identity ceremony (ADR 0060).
 *
 * The ceremony's primary path is bindable auth providers, not social-login
 * buttons: WorkOS, Okta, Auth0, and Better Auth each get a tailored form, and
 * every one of them rides the shipped BYO registration (ADR 0055) — they are
 * OIDC issuers, so the server's SSRF-fenced discovery and RFC 7591 DCR do the
 * real work. This module is dumb data plus pure issuer assembly; it never
 * talks to the network.
 */

import type { IdpProviderType } from "./idp-registry.js";

export type IdpPresetField = {
  label: string;
  placeholder: string;
  hint: string;
};

export type IdpPreset = {
  type: IdpProviderType;
  label: string;
  /** The issuer-lead field; WorkOS has none — its issuer is fixed. */
  field: IdpPresetField | null;
};

export const IDP_PRESETS: readonly IdpPreset[] = [
  {
    type: "workos",
    label: "WorkOS",
    field: null,
  },
  {
    type: "okta",
    label: "Okta",
    field: {
      label: "Okta domain",
      placeholder: "dev-123456.okta.com",
      hint: "Your Okta org domain — https:// is optional.",
    },
  },
  {
    type: "auth0",
    label: "Auth0",
    field: {
      label: "Tenant domain",
      placeholder: "acme.auth0.com",
      hint: "Your Auth0 tenant or custom domain.",
    },
  },
  {
    type: "better-auth",
    label: "Better Auth",
    field: {
      label: "Deployment URL",
      placeholder: "https://auth.acme.com",
      hint: "The base URL of the deployment — http only on localhost.",
    },
  },
];

export function presetFor(type: IdpProviderType): IdpPreset | null {
  return IDP_PRESETS.find((preset) => preset.type === type) ?? null;
}

export type IssuerResult =
  | { ok: true; issuer: string }
  | { ok: false; error: string };

/** dev-123456.okta.com, including .oktapreview.com. */
const OKTA_DOMAIN_RE =
  /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*\.(okta|oktapreview)\.com$/;

/** Domain-ish shape: dotted labels, at least one dot (covers custom domains). */
const DOMAIN_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

/** A domain field as a bare host: protocol, path, and trailing slashes off. */
function bareHost(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

/** http stays local-dev only: loopback hosts, never the open network. */
function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1";
}

/**
 * The issuer a preset form submits, or the one-line reason it cannot be
 * built. Validation is client-side only — the server re-checks everything
 * during discovery.
 */
export function presetIssuer(
  type: IdpProviderType,
  input: string,
): IssuerResult {
  switch (type) {
    case "workos":
      // AuthKit's issuer is fixed for every WorkOS deployment.
      return { ok: true, issuer: "https://api.workos.com" };
    case "okta": {
      const host = bareHost(input);
      if (!OKTA_DOMAIN_RE.test(host)) {
        return {
          ok: false,
          error: "Use your Okta domain, like dev-123456.okta.com.",
        };
      }
      return { ok: true, issuer: `https://${host}` };
    }
    case "auth0": {
      const host = bareHost(input);
      if (!DOMAIN_RE.test(host)) {
        return {
          ok: false,
          error: "Use a tenant domain, like acme.auth0.com.",
        };
      }
      return { ok: true, issuer: `https://${host}` };
    }
    case "better-auth":
      return issuerFromUrl(
        input,
        "Use the deployment URL, like https://auth.acme.com.",
      );
  }
}

/**
 * An issuer given as a bare URL — the road for any OIDC provider without a
 * preset of its own (Keycloak, Authentik, Zitadel, a deployment's own server),
 * and the rule Better Auth's deployment URL follows.
 *
 * Client-side shape only: the server re-runs discovery behind its SSRF fence
 * and is the thing that decides whether the issuer is real.
 */
export function issuerFromUrl(
  input: string,
  malformed = "Use the issuer's base URL, like https://idp.acme.com.",
): IssuerResult {
  // The issuer is the URL as entered, minus trailing slashes.
  const issuer = input.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    return { ok: false, error: malformed };
  }
  if (parsed.protocol === "https:") return { ok: true, issuer };
  if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) {
    return { ok: true, issuer };
  }
  return {
    ok: false,
    error: "https is required, except on localhost for local dev.",
  };
}
