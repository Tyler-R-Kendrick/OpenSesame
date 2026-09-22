/**
 * Worker variants with owned-cache scoping.
 *
 * Each plan generation gets variant cache namespaced by
 * `${variantId}:${planDigest}`. Eviction deletes ONLY names in that
 * namespace — never an origin-wide sweep like the legacy activate handler
 * in sw.ts, which deletes every cache that is not the current shell.
 */
import type { WorkerVariantRef } from "@opensesame/capability-composition";

/** Cache namespace owned by one variant of one plan. */
export function variantCacheName(ref: WorkerVariantRef): string {
  return `variant:${ref.variantId}:${ref.planDigest}`;
}

/** True when a cache name belongs to the variant's namespace. */
export function ownsCache(ref: WorkerVariantRef, cacheName: string): boolean {
  return cacheName.startsWith(`variant:${ref.variantId}:`);
}

/** Names this variant may evict: owned but not the current digest. */
export function evictableCaches(
  ref: WorkerVariantRef,
  names: readonly string[],
): readonly string[] {
  const current = variantCacheName(ref);
  return names.filter((n) => ownsCache(ref, n) && n !== current);
}

/** A variant A can never read variant B's namespace. */
export function isolated(reader: WorkerVariantRef, cacheName: string): boolean {
  return ownsCache(reader, cacheName);
}
