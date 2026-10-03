import { isString } from "@opensesame/os-domain";
/**
 * Pinned OAuth2 Proxy (v7.8.2) OIDC consumer contract. Not a native reverse
 * proxy — operators run the upstream binary; this only emits discovery-backed
 * configuration and names the fields that must exist on the issuer.
 */
export const OAUTH2_PROXY_PINNED_VERSION = "v7.8.2";

export const OAUTH2_PROXY_REQUIRED_DISCOVERY = [
  "issuer",
  "authorization_endpoint",
  "token_endpoint",
  "jwks_uri",
  "userinfo_endpoint",
] as const;

export type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint: string;
  code_challenge_methods_supported?: string[];
};

export function oauth2ProxyDiscoveryGaps(doc: OidcDiscovery): string[] {
  return OAUTH2_PROXY_REQUIRED_DISCOVERY.filter((key) => {
    const value = doc[key];
    return !isString(value) || value.length === 0;
  });
}

const UNSAFE_CONFIG_CHARS = /["\\\n\r]/;
const CLIENT_ID_CHARS = /^[A-Za-z0-9._@:/-]+$/;
const EMAIL_DOMAIN_CHARS = /^(\*|[A-Za-z0-9.-]+)$/;

function assertConfigValue(name: string, value: string): void {
  if (UNSAFE_CONFIG_CHARS.test(value)) {
    throw new Error(
      `${name} must not contain quotes, backslashes, or line breaks.`,
    );
  }
}

function assertHttpsUrl(name: string, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error(`${name} must use https (http is loopback-only).`);
  }
}

function assertEmailDomains(domains: readonly string[]): void {
  for (const domain of domains) {
    assertConfigValue("emailDomains", domain);
    if (!EMAIL_DOMAIN_CHARS.test(domain)) {
      throw new Error(`emailDomains entry is not a valid domain: ${domain}`);
    }
  }
}

/** Generate a public-PKCE oauth2-proxy.cfg. Never embeds a client secret. */
export function oauth2ProxyConfig(input: {
  discovery: OidcDiscovery;
  clientId: string;
  redirectUrl: string;
  emailDomains?: readonly string[];
}): string {
  const gaps = oauth2ProxyDiscoveryGaps(input.discovery);
  if (gaps.length > 0) {
    throw new Error(`Issuer discovery is missing ${gaps.join(", ")}.`);
  }
  if (!input.clientId || !input.redirectUrl) {
    throw new Error("clientId and redirectUrl are required.");
  }
  const methods = input.discovery.code_challenge_methods_supported ?? [];
  if (!methods.includes("S256")) {
    throw new Error("Issuer must advertise PKCE S256 for OAuth2 Proxy.");
  }
  assertConfigValue("issuer", input.discovery.issuer);
  assertHttpsUrl("issuer", input.discovery.issuer);
  assertConfigValue("clientId", input.clientId);
  if (!CLIENT_ID_CHARS.test(input.clientId)) {
    throw new Error("clientId contains characters outside the allowlist.");
  }
  assertConfigValue("redirectUrl", input.redirectUrl);
  assertHttpsUrl("redirectUrl", input.redirectUrl);
  const domains = input.emailDomains ?? ["*"];
  assertEmailDomains(domains);
  return `# oauth2-proxy ${OAUTH2_PROXY_PINNED_VERSION}
# Public PKCE client. Do not put a client secret in this file.
provider = "oidc"
oidc_issuer_url = "${input.discovery.issuer}"
client_id = "${input.clientId}"
redirect_url = "${input.redirectUrl}"
code_challenge_method = "S256"
oidc_email_claim = "email"
email_domains = "${domains.join(",")}"
skip_provider_button = true
`;
}
