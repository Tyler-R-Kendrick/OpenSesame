/**
 * Service-worker / offline asset mismatch handling (BUILD-F / INV-30).
 * Mismatch ⇒ readiness must not claim verified_ready.
 */

import type { AssuranceLevel } from "./assets.js";

export type SwAssetManifest = Readonly<{
  /** Build-time expected digests keyed by capability id. */
  expected: Readonly<Record<string, string>>;
  /** Digests currently held by the SW / Cache API. */
  cached: Readonly<Record<string, string>>;
}>;

export type SwMismatchReport = Readonly<{
  mismatch: boolean;
  missingFromCache: readonly string[];
  digestDrift: readonly string[];
  /** Max honest assurance after accounting for mismatch. */
  maxAssurance: AssuranceLevel;
  detail: string;
}>;

export function evaluateServiceWorkerMismatch(
  manifest: SwAssetManifest,
): SwMismatchReport {
  const missingFromCache: string[] = [];
  const digestDrift: string[] = [];

  for (const [id, expected] of Object.entries(manifest.expected)) {
    const cached = manifest.cached[id];
    if (cached === undefined) {
      missingFromCache.push(id);
      continue;
    }
    if (cached !== expected) {
      digestDrift.push(id);
    }
  }

  const mismatch = missingFromCache.length > 0 || digestDrift.length > 0;
  const maxAssurance: AssuranceLevel = mismatch
    ? missingFromCache.length > 0
      ? "unavailable"
      : "configured"
    : "verified_ready";

  const parts: string[] = [];
  if (missingFromCache.length)
    parts.push(`missing=${missingFromCache.join(",")}`);
  if (digestDrift.length) parts.push(`drift=${digestDrift.join(",")}`);

  return {
    mismatch,
    missingFromCache,
    digestDrift,
    maxAssurance,
    detail: mismatch ? parts.join(";") : "aligned",
  };
}

/**
 * Clamp an offline-assets assurance so SW mismatch cannot inflate readiness.
 */
export function clampAssuranceForSw(
  current: AssuranceLevel,
  mismatch: SwMismatchReport,
): AssuranceLevel {
  if (!mismatch.mismatch) return current;
  const rank = {
    unavailable: 0,
    unsupported: 1,
    configured: 2,
    verified_ready: 3,
  } as const satisfies Record<AssuranceLevel, number>;
  return rank[current] <= rank[mismatch.maxAssurance]
    ? current
    : mismatch.maxAssurance;
}
