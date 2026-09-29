/**
 * The origin grammar for a policy's `allowedServiceOrigins` (carried from
 * #470, which refused a malformed origin at parse). An entry is exactly what
 * `URL.origin` prints — scheme, host and a non-default port, nothing else —
 * over https or wss, or over http or ws only to this machine's loopback. A
 * WebSocket carrier is listed as its own `wss://` origin: a CSP `https:`
 * source does not admit one, so an https entry never stands for it. Egress compares
 * `url.origin` against the list, so a trailing slash, a path, a capital
 * letter or a bare host would never match: rather than deny every request
 * without a word, the document is refused with the entry named.
 */

/** The hosts egress treats as loopback (`targetAddressSpaceFor` in app-core). */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/**
 * A DNS name, IPv4 address or bracketed IPv6 literal. `URL` also accepts a
 * `*` in a special-scheme host, which a CSP source would read as "every
 * subdomain": an allowlist entry names one host.
 */
const HOST = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])$/;

export function isServiceOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== value || !HOST.test(url.hostname)) return false;
  if (url.protocol === "https:" || url.protocol === "wss:") return true;
  return (
    (url.protocol === "http:" || url.protocol === "ws:") &&
    isLoopbackHost(url.hostname)
  );
}
