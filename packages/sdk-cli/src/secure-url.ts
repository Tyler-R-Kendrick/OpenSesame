function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  return /^127(?:\.\d{1,3}){3}$/u.test(host);
}

/**
 * Every URL the CLI sends a code, a verifier, or a bearer token to must be one an
 * onlooker cannot rewrite. http is tolerated only on loopback, where the
 * development server lives.
 */
export function assertSecureUrl(raw: string, what: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${what} must be an absolute URL`);
  }
  if (url.protocol === "https:") return raw;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return raw;
  throw new Error(`${what} must use https (http is allowed only on loopback)`);
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}

/**
 * The discovery document decides where the CLI sends the code and the verifier.
 * An issuer that does not name itself is a document that came from somewhere else.
 */
export function assertDiscoveryBelongsToIssuer(
  meta: { issuer?: string },
  issuer: string,
): void {
  if (trimSlash(meta.issuer ?? "") !== issuer) {
    throw new Error("OIDC discovery issuer does not match the configured issuer");
  }
}
