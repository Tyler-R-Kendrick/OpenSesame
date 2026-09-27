/**
 * The origin grammar for a policy's `allowedServiceOrigins` (carried from
 * #470, which refused a malformed origin at parse). An entry is exactly what
 * `URL.origin` prints — scheme, host and a non-default port, nothing else —
 * over https, or over http only to this machine's loopback. Egress compares
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

export function isServiceOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== value) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}
