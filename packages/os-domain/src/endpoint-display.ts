/**
 * Shortening endpoint and remote URLs for display.
 *
 * These live in the domain rather than in the surface that renders them for
 * two reasons. They are pure string functions over values a person typed into
 * settings — attacker-influenced the moment anything can write our storage —
 * so they belong where the fuzz suite can reach them. And more than one
 * surface has to shorten the same values the same way: a status glyph, a
 * connector tile and a ceremony that all disagree about how to write an
 * address are three different answers to one question.
 *
 * Neither function validates. Deciding whether a URL may be *called* is
 * `normalizeHttpBaseUrl`'s job in `@opensesame/api-client`; this only decides
 * how to write one down, and must never throw for anything a person can type.
 */

/**
 * `http://127.0.0.1:18787/` reads as `127.0.0.1:18787`.
 *
 * A status line is narrow and a scheme is the least informative part of an
 * origin — every one of these is http or https. Anything that does not parse
 * is passed through unchanged rather than blanked, because showing a person
 * the nonsense they typed is how they spot the typo.
 */
export function briefOrigin(raw: string): string {
  const trimmed = raw.trim();
  // Stryker disable next-line ConditionalExpression: equivalent — see repoHint.
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    // Only http(s) gets shortened. `new URL` happily parses `w:anything` as an
    // opaque scheme with no host, so shortening it would return a
    // percent-encoded pathname — longer than what was typed, and nothing the
    // person who typed it would recognise. These settings only ever hold
    // http(s) anyway; anything else is a typo, and showing a typo back
    // verbatim is how someone spots it.
    if (url.protocol !== "http:" && url.protocol !== "https:") return trimmed;
    return `${url.host}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return trimmed;
  }
}

/**
 * `https://github.com/org/store.git` reads as `org/store`.
 *
 * The host is noise once a connector has already named the provider, and the
 * owner/repo is the part someone recognises. Anything that does not parse as
 * a URL — an scp-style `git@host:owner/repo`, most obviously — is passed
 * through with only the `.git` suffix removed.
 */
export function repoHint(remote: string): string {
  const withoutSuffix = stripGitSuffix(remote.trim());
  // Stryker disable next-line ConditionalExpression: equivalent — an empty
  // string falls through to `new URL("")`, which throws, and the catch returns
  // the same "". The guard is here to keep a common input off the throw path,
  // not to change the answer.
  if (!withoutSuffix) return "";
  try {
    const url = new URL(withoutSuffix);
    // A remote worth shortening has an authority — `https://host/owner/repo`.
    // A schemed string without one (`w:owner/repo`) is not a remote, and
    // taking its pathname would percent-encode whatever was typed into
    // something longer and stranger than the original.
    if (!url.host) return withoutSuffix;
    return stripLeadingSlashes(url.pathname) || withoutSuffix;
  } catch {
    return withoutSuffix;
  }
}

/**
 * Only a trailing `.git` is a suffix.
 *
 * Written as an explicit test rather than `/\.git$/` because the anchor is the
 * whole point and an unanchored version quietly mangles any path that merely
 * contains the letters — `owner/.github` would become `owner/hub`.
 */
function stripGitSuffix(remote: string): string {
  return remote.endsWith(".git") ? remote.slice(0, -".git".length) : remote;
}

/** A URL pathname always begins with a slash, and sometimes with several. */
function stripLeadingSlashes(path: string): string {
  let rest = path;
  while (rest.startsWith("/")) rest = rest.slice(1);
  return rest;
}
