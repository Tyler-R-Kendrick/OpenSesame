/**
 * Which build a worker belongs to.
 *
 * vite-plugin-pwa injects `self.__WB_MANIFEST` into `sw.js`; the push
 * variant's build (`scripts/build-workers.mjs`) defines the same expression
 * with the same content. Both hold the shell's `revision` — an md5 of the
 * emitted `index.html`, which references the hashed entry chunk, whose hash
 * changes whenever anything it imports changes — so the revision is a
 * fingerprint of the whole release, not only of the shell file.
 *
 * The id is a cache-name segment, so it may never contain a colon.
 */

import { type BoundaryValue, isJsonObject, isString } from "@opensesame/os-domain";

export type ManifestEntry = string | Readonly<{ url: string; revision?: string | null }>;

export const SHELL_URL = "index.html";

/** The shell entry as a URL string, or `null` when the manifest lacks one. */
export function shellEntry(manifest: readonly ManifestEntry[]): string | null {
  for (const entry of manifest) {
    const url = isString(entry) ? entry : entry.url;
    if (url === SHELL_URL) return url;
  }
  return null;
}

/** Deterministic 32-bit FNV-1a over a string, as eight hex digits. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The release id: the shell's revision when the manifest carries one, else
 * a hash of the manifest as a whole (the dev server hands the worker an
 * empty manifest; every dev load is then release `dev-…`).
 */
export function releaseIdFromManifest(
  manifest: readonly ManifestEntry[],
): string {
  for (const entry of manifest) {
    if (isString(entry) || entry.url !== SHELL_URL) continue;
    if (isString(entry.revision) && /^[A-Za-z0-9_-]{1,64}$/.test(entry.revision))
      return entry.revision;
  }
  return `dev-${fnv1a(JSON.stringify(manifest))}`;
}

/** Narrow whatever the build injected; anything else is an empty manifest. */
export function manifestFromBoundary(value: BoundaryValue): ManifestEntry[] {
  if (!Array.isArray(value)) return [];
  const out: ManifestEntry[] = [];
  for (const entry of value) {
    if (isString(entry)) out.push(entry);
    else if (isJsonObject(entry) && isString(entry.url))
      out.push({
        url: entry.url,
        revision: isString(entry.revision) ? entry.revision : null,
      });
  }
  return out;
}
