/**
 * Filter slugs a vault link may still carry from before ADR 0168: `?f=login`
 * (the old type id) and `?f=logins` (the old rail directory). Both name the
 * account type now. Every reader of `?f=` resolves it through here.
 */

const LEGACY_FILTER_SLUGS: ReadonlyMap<string, string> = new Map([
  ["login", "account"],
  ["logins", "account"],
]);

/** The filter a `?f=` value names, with a legacy slug read as its type. */
export function resolveFilterSlug(filter: string): string {
  return LEGACY_FILTER_SLUGS.get(filter) ?? filter;
}
