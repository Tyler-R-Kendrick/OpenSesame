/**
 * Canonical form of a resource indicator (RFC 8707 §2): absolute URI, no
 * fragment, no query, case-normalized scheme/host, no trailing slash.
 * Returns null when the value is not usable as a resource indicator.
 */
export function canonicalResource(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hash || url.search) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}`;
}

/**
 * Whether this issuer will mint an access token audienced to `resource`.
 * With no configured allowlist the only accepted audience is the issuer itself.
 */
export function isResourceAllowed(
  resource: string,
  allowed: readonly string[],
  issuer: string,
): boolean {
  const target = canonicalResource(resource);
  if (!target) return false;
  const permitted = (allowed.length > 0 ? allowed : [issuer])
    .map((entry) => canonicalResource(entry))
    .filter((entry): entry is string => entry !== null);
  return permitted.includes(target);
}
