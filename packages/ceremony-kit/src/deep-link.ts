/**
 * The machine-derivable parts of a ceremony link.
 *
 * Every ceremony page reads these once and takes the bearer out of the URL
 * immediately; an agent handed the same link can derive the same inputs and
 * call the JSON API directly (ADR 0045).
 */

/**
 * Extract `token` from a location hash (`#token=…`).
 *
 * Fragment transport keeps the bearer out of request lines, server logs, and
 * `Referer` headers — the query string would carry it into all three.
 */
export function readFragmentToken(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const token = new URLSearchParams(raw).get("token");
  return token && token.length > 0 ? token : null;
}

/**
 * Extract and normalize `user_code` from a query string (`?user_code=…`).
 *
 * A user code is a display artifact rather than a bearer, so the query string
 * is an acceptable carrier for it. Uppercase and tolerate copied whitespace.
 */
export function parseUserCode(search: string): string | null {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const code = new URLSearchParams(raw).get("user_code");
  if (!code) return null;
  const trimmed = code.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The URL with its fragment removed, for `history.replaceState`. Returned
 * rather than applied so this module stays free of browser globals.
 */
export function scrubFragment(pathname: string, search: string): string {
  return `${pathname}${search}`;
}
