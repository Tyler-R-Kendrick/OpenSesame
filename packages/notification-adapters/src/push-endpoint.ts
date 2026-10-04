/**
 * One spelling per push endpoint.
 *
 * A push endpoint is a capability URL and its digest is how a registration is
 * matched to the row that already holds it: the ownership rule only means
 * something if two spellings of the same URL land on the same digest. Digesting
 * the raw string let `https://Push.Example.test:443/x` and
 * `https://push.example.test/x#a` sit beside each other as two rows for one
 * browser, the second one slipping past the first owner's claim.
 *
 * The WHATWG URL serialization already lowercases the host, drops a default
 * port, resolves dot segments and encodes an internationalized name. On top of
 * that: no fragment (never sent to a server), no trailing dot on the host (the
 * same DNS name), and percent-escapes in the path and query spelled one way
 * (unreserved characters decoded, the rest upper-case hex). Path and query case
 * is otherwise left alone: servers are free to treat it as significant.
 */

const ESCAPE = /%[0-9A-Fa-f]{2}/gu;
const UNRESERVED = /^[A-Za-z0-9\-._~]$/u;

function canonicalEscapes(part: string): string {
  return part.replace(ESCAPE, (escape) => {
    const char = String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    return UNRESERVED.test(char) ? char : escape.toUpperCase();
  });
}

/** The endpoint in its one canonical spelling, or `undefined` if it is not a URL. */
export function normalizePushEndpoint(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  url.hash = "";
  url.hostname = url.hostname.replace(/\.+$/u, "");
  url.pathname = canonicalEscapes(url.pathname);
  if (url.search) url.search = canonicalEscapes(url.search);
  return url.href;
}
