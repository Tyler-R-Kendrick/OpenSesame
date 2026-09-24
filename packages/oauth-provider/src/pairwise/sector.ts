/**
 * Pairwise sector keys — the one place a registered `sectorIdentifier` becomes
 * the string pairwise subjects are keyed on.
 *
 * The registry's `sectorIdentifier` is what ownership is checked against
 * (`packages/control-plane` refuses a sector another owner holds), so it — not the
 * host of `redirect_uris[0]`, which oidc-provider falls back to without a
 * `sector_identifier_uri` — has to be what decides the `sub`. Otherwise two
 * owners whose redirect URIs share a host (`localhost:3000`, a multi-tenant
 * host) see the same subject for the same person.
 *
 * Keys are chosen so the common conformant registration keeps the subject it
 * already had: an origin-form sector (`https://rp.example`) keys on its host,
 * exactly what oidc-provider derived from `https://rp.example/cb`. A sector
 * with a path keys on host + path, so `https://shared.example/a` and
 * `https://shared.example/b` stay apart. A value that is not an http(s) URL
 * (an origin client's `sector_<uuid>`, a static client's bare host) is used
 * verbatim; none of those contain a `/`, so they cannot meet a path key.
 */
function parseHttpUrl(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  return url.hostname ? url : undefined;
}

/** The string pairwise subjects are stored under for a registered sector. */
export function pairwiseSectorKey(sectorIdentifier: string): string {
  const raw = sectorIdentifier.trim();
  const url = parseHttpUrl(raw);
  if (!url) return raw;
  return url.pathname === "/" ? url.host : `${url.host}${url.pathname}`;
}

/**
 * The pairwise store's sector for a key at a claim generation.
 *
 * Generation 0 is the key itself, so every subject minted before generations
 * existed stays where it is. A later generation (an operator released the key
 * from a squatter) appends ` #<n>`: no key can contain a space — a URL-form
 * key is a parsed host and path, which percent-encode it, and migration 0029
 * blocked every legacy spelling holding one — so no key at any generation can
 * equal another key's, and a new holder starts with no subjects at all.
 */
export function pairwiseSubjectSector(
  sectorKey: string,
  generation = 0,
): string {
  return generation > 0 ? `${sectorKey} #${generation}` : sectorKey;
}

/**
 * The canonical spelling a registry stores for a URL-form sector, so an exact
 * lookup finds every registration that shares a key: lowercase host, default
 * port dropped, no trailing `/` on an origin-form sector.
 */
export function canonicalSectorIdentifier(sectorIdentifier: string): string {
  const raw = sectorIdentifier.trim();
  const url = parseHttpUrl(raw);
  if (!url) return raw;
  return url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`;
}

/**
 * Every spelling an exact-match registry lookup must try to find the holders
 * of a sector's key: the canonical form, the form as given, and — for an
 * origin-form sector — its trailing-slash twin, which older registrations
 * may have stored.
 */
export function sectorIdentifierSpellings(sectorIdentifier: string): string[] {
  const canonical = canonicalSectorIdentifier(sectorIdentifier);
  const spellings = new Set([canonical, sectorIdentifier]);
  const url = parseHttpUrl(canonical);
  if (url && url.pathname === "/") spellings.add(`${url.origin}/`);
  return [...spellings];
}
