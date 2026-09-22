/**
 * Cache Storage names this application owns (ownership.md §4.7, PWA-04).
 *
 * Every name is `opensesame-pages:<scopePath>:<releaseId>:<variant>`. The
 * scope path keeps two deployments on one origin (`/OpenSesame/` beside
 * `/other-app/`) from ever touching each other's entries; the release id
 * keeps one build from answering with another build's shell; the variant
 * keeps the core-only and push workers from sharing a namespace. A worker
 * only ever opens names it built with these functions — never
 * origin-wide `caches.match`, never a name it did not construct.
 */

export const CACHE_PREFIX = "opensesame-pages";

/** The variant slot used while a plan downloads (PWA-07). */
export const STAGING_VARIANT = "staging";

export type ParsedCacheName = Readonly<{
  scopePath: string;
  releaseId: string;
  variant: string;
}>;

/** `/OpenSesame/` from `https://host/OpenSesame/` — never the origin. */
export function scopePathOf(scope: string): string {
  return new URL(scope).pathname;
}

/** Every cache of this application under this scope starts with this. */
export function scopePrefix(scopePath: string): string {
  return `${CACHE_PREFIX}:${scopePath}:`;
}

export function cacheName(
  scopePath: string,
  releaseId: string,
  variant: string,
): string {
  return `${scopePrefix(scopePath)}${releaseId}:${variant}`;
}

export function stagingCacheName(scopePath: string, releaseId: string): string {
  return cacheName(scopePath, releaseId, STAGING_VARIANT);
}

/**
 * Read a name back. `null` for anything that is not ours under this scope,
 * including another OpenSesame deployment's caches on the same origin. A
 * pathname carries no colon, so the two remaining fields split cleanly.
 */
export function parseCacheName(
  name: string,
  scopePath: string,
): ParsedCacheName | null {
  const prefix = scopePrefix(scopePath);
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  const colon = rest.indexOf(":");
  if (colon <= 0 || colon === rest.length - 1) return null;
  const releaseId = rest.slice(0, colon);
  const variant = rest.slice(colon + 1);
  if (variant.includes(":")) return null;
  return { scopePath, releaseId, variant };
}
