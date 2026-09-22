/**
 * Retire caches this worker no longer needs — and only those (PWA-04).
 *
 * A name is deleted when all of the following hold: it parses as one of ours
 * under this worker's scope path, it belongs to a release other than the
 * current one, and that release is not retained for a window still running
 * it. Every other name on the origin — another application's cache, another
 * OpenSesame deployment under a different path, the current release, a
 * retained release — is left exactly as it was.
 */

import { parseCacheName } from "./cache-names.js";

export type CleanupInput = Readonly<{
  caches: CacheStorage;
  scopePath: string;
  releaseId: string;
  /** Release ids still in use by windows the worker took over (PWA-04). */
  retained: ReadonlySet<string>;
}>;

/** Decide, without touching storage, which names would go. */
export function staleCacheNames(
  names: readonly string[],
  input: Omit<CleanupInput, "caches">,
): string[] {
  const stale: string[] = [];
  for (const name of names) {
    const parsed = parseCacheName(name, input.scopePath);
    if (!parsed) continue;
    if (parsed.releaseId === input.releaseId) continue;
    if (input.retained.has(parsed.releaseId)) continue;
    stale.push(name);
  }
  return stale;
}

/** Delete the stale names; returns what was deleted. Never throws. */
export async function cleanupCaches(input: CleanupInput): Promise<string[]> {
  let names: string[];
  try {
    names = await input.caches.keys();
  } catch {
    return [];
  }
  const stale = staleCacheNames(names, input);
  const deleted: string[] = [];
  for (const name of stale) {
    try {
      if (await input.caches.delete(name)) deleted.push(name);
    } catch {
      // A name that will not delete is left for the next activation.
    }
  }
  return deleted;
}
