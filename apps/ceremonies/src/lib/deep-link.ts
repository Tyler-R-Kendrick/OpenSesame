/**
 * Pure helpers for the machine-derivable parts of a ceremony link. Pages read
 * these once and scrub the URL; agents handed the same link can derive the
 * same inputs and call the JSON API directly (ADR 0045 decision 5).
 */

/** Extract `token` from a location hash (`#token=…`). Fragment transport keeps
 * the bearer out of request lines, logs, and referrers. */
export function readFragmentToken(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const token = new URLSearchParams(raw).get("token");
  return token && token.length > 0 ? token : null;
}

/** Extract and normalize `user_code` from a query string (`?user_code=…`).
 * User codes are display artifacts: uppercase, tolerate copied whitespace. */
export function parseUserCode(search: string): string | null {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const code = new URLSearchParams(raw).get("user_code");
  if (!code) return null;
  const trimmed = code.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}
