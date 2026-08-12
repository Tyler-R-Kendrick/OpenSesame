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

/**
 * Hosts that only mean something inside this machine's network.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (isLoopbackHost(host)) return true;
  if (host === "0.0.0.0" || host === "::") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (/^f[cd][0-9a-f]{2}:/u.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/u.test(host)) return true;
  return host.endsWith(".internal") || host.endsWith(".local");
}

/**
 * An endpoint the issuer told us about, rather than one the operator wrote.
 *
 * `assertSecureUrl` tolerates cleartext on loopback, which is right for a value in
 * this machine's own configuration and wrong for a value a remote party supplies:
 * it lets any issuer aim the CLI's next request — carrying a device code, a
 * verifier, or a client assertion — at a listener on this machine. A discovered
 * endpoint may only name private space when the issuer is itself private, which is
 * the local development case where both ends are here anyway.
 */
export function assertDiscoveredUrl(
  raw: string,
  what: string,
  issuer: string,
): string {
  const checked = assertSecureUrl(raw, what);
  let issuerHost: string;
  try {
    issuerHost = new URL(issuer).hostname;
  } catch {
    throw new Error("issuer must be an absolute URL");
  }
  if (isPrivateHost(issuerHost)) return checked;
  if (isPrivateHost(new URL(checked).hostname)) {
    throw new Error(
      `${what} names a private or loopback host, but the issuer is remote`,
    );
  }
  return checked;
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
    throw new Error(
      "OIDC discovery issuer does not match the configured issuer",
    );
  }
}
