/**
 * Self-Issued OP issuer profile resolution and dynamic issuer allowlist.
 */

import { refuse } from "./errors.js";

export const STATIC_SELF_ISSUED_ISSUER = "https://self-issued.me/v2" as const;

/**
 * Draft static Self-Issued OP metadata shape (SIOPv2 ID1 §6).
 * Documented for RP interoperability; the web PWA does not register an
 * `openid:` custom-scheme handler — invocation uses HTTPS `/identity/siop`.
 */
export const STATIC_SIOP_METADATA = {
  issuer: STATIC_SELF_ISSUED_ISSUER,
  authorization_endpoint: "openid:",
  response_types_supported: ["id_token"],
  scopes_supported: ["openid"],
  subject_types_supported: ["pairwise"],
  id_token_signing_alg_values_supported: ["ES256"],
  subject_syntax_types_supported: ["urn:ietf:params:oauth:jwk-thumbprint"],
} as const;

export type SiopIssuerProfile =
  | { readonly kind: "static" }
  | { readonly kind: "dynamic"; readonly issuer: string };

export type ResolvedIssuer = {
  readonly iss: string;
  readonly iAmSiop: boolean;
};

export function assertAllowedIssuer(issuer: string): void {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    refuse("issuer_mismatch", "issuer_profile");
  }
  if (url.username !== "" || url.password !== "") {
    refuse("issuer_mismatch", "issuer_profile");
  }
  if (url.hash !== "" || url.search !== "") {
    refuse("issuer_mismatch", "issuer_profile");
  }
  if (url.protocol === "https:") {
    if (!issuer.startsWith("https://")) {
      refuse("issuer_mismatch", "issuer_profile");
    }
    return;
  }
  // Loopback HTTP only — same floor as SIOP redirect_uri rules for local dogfood.
  if (url.protocol === "http:") {
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
      return;
    }
  }
  refuse("issuer_mismatch", "issuer_profile");
}

export function resolveIssuer(profile: SiopIssuerProfile): ResolvedIssuer {
  if (profile.kind === "static") {
    return { iss: STATIC_SELF_ISSUED_ISSUER, iAmSiop: false };
  }
  assertAllowedIssuer(profile.issuer);
  if (profile.issuer === STATIC_SELF_ISSUED_ISSUER) {
    refuse("issuer_mismatch", "issuer_profile");
  }
  return { iss: profile.issuer, iAmSiop: true };
}
