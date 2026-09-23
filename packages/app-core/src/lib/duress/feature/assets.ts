import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  type MutableJsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
  readString,
} from "../json-boundary.js";
/**
 * Enrollment-time offline asset readiness (BUILD-B / INV-30).
 * Assurance levels match packages/contracts DuressAssuranceLevelSchema.
 */

import { type DuressCapability, capabilitiesForMode } from "./registry.js";
import type { DuressFeatureMode } from "./types.js";

/** Wire-compatible with contracts `DuressAssuranceLevelSchema`. */
export type AssuranceLevel =
  | "unavailable"
  | "unsupported"
  | "configured"
  | "verified_ready";

export type OfflineAssetEntry = Readonly<{
  capabilityId: string;
  modulePath: string;
  /** Content digest or cache key when known. */
  digest: string | null;
  present: boolean;
}>;

export type OfflineReadinessReport = Readonly<{
  mode: DuressFeatureMode;
  offlineAssets: AssuranceLevel;
  durableStorage: AssuranceLevel;
  entries: readonly OfflineAssetEntry[];
  swMismatch: boolean;
  reasons: readonly string[];
  /** True only when enrollment may claim offline-ready. */
  mayClaimOfflineReady: boolean;
}>;

export type AssetProbe = Readonly<{
  /** Returns true when the module bytes are locally available. */
  modulePresent: (cap: DuressCapability) => boolean | Promise<boolean>;
  /** Optional digest of cached bytes (null if unknown). */
  moduleDigest?: (
    cap: DuressCapability,
  ) => string | null | Promise<string | null>;
  /** Expected digests from the current build manifest. */
  expectedDigests?: Readonly<Record<string, string>>;
  /** Durable storage (IndexedDB / Cache API) probe. */
  durableStorageAvailable?: boolean;
}>;

function durableAssurance(probe: AssetProbe): AssuranceLevel {
  if (probe.durableStorageAvailable === undefined) return "configured";
  return probe.durableStorageAvailable ? "verified_ready" : "unavailable";
}

function entriesVerifiedAgainstManifest(
  entries: readonly OfflineAssetEntry[],
  expectedDigests: Readonly<Record<string, string>> | undefined,
): boolean {
  if (!expectedDigests) return entries.length > 0;
  return entries.every((e) => {
    const expected = expectedDigests[e.capabilityId];
    return !expected || e.digest === expected;
  });
}

type OfflineAssetsAssuranceInput = Readonly<{
  missing: number;
  swMismatch: boolean;
  entries: readonly OfflineAssetEntry[];
  expectedDigests: Readonly<Record<string, string>> | undefined;
  reasons: string[];
}>;

function offlineAssetsAssurance(
  input: OfflineAssetsAssuranceInput,
): AssuranceLevel {
  if (input.missing > 0) return "unavailable";
  if (input.swMismatch) {
    input.reasons.push("offline_assets_not_verified_due_to_sw_mismatch");
    return "configured";
  }
  const allPresent = input.entries.every((e) => e.present);
  if (
    allPresent &&
    entriesVerifiedAgainstManifest(input.entries, input.expectedDigests)
  ) {
    return input.expectedDigests &&
      Object.keys(input.expectedDigests).length > 0
      ? "verified_ready"
      : "configured";
  }
  return "configured";
}

type ScanOfflineEntriesResult = Readonly<{
  entries: OfflineAssetEntry[];
  missing: number;
  swMismatch: boolean;
}>;

async function scanOfflineEntries(
  caps: readonly DuressCapability[],
  probe: AssetProbe,
  reasons: string[],
): Promise<ScanOfflineEntriesResult> {
  const entries: OfflineAssetEntry[] = [];
  let missing = 0;
  let swMismatch = false;
  for (const cap of caps) {
    const present = await probe.modulePresent(cap);
    const digest = probe.moduleDigest ? await probe.moduleDigest(cap) : null;
    const expected = probe.expectedDigests?.[cap.id];
    if (expected && digest && expected !== digest) {
      swMismatch = true;
      reasons.push(`sw_mismatch:${cap.id}`);
    }
    if (!present) {
      missing += 1;
      reasons.push(`missing:${cap.id}`);
    }
    entries.push({
      capabilityId: cap.id,
      modulePath: cap.modulePath,
      digest,
      present,
    } satisfies OfflineAssetEntry);
  }
  return { entries, missing, swMismatch } satisfies ScanOfflineEntriesResult;
}

/**
 * Evaluate offline readiness. SW / digest mismatch ⇒ never verified_ready.
 */
export async function evaluateOfflineAssetReadiness(
  mode: DuressFeatureMode,
  probe: AssetProbe,
): Promise<OfflineReadinessReport> {
  const reasons: string[] = [];

  if (mode === "off") {
    return {
      mode,
      offlineAssets: "unsupported",
      durableStorage: "unsupported",
      entries: [],
      swMismatch: false,
      reasons: ["feature_off"],
      mayClaimOfflineReady: false,
    };
  }

  const caps = capabilitiesForMode(mode).filter((c) => c.kind !== "ui");
  const { entries, missing, swMismatch } = await scanOfflineEntries(
    caps,
    probe,
    reasons,
  );
  const durable = durableAssurance(probe);
  if (durable === "unavailable") {
    reasons.push("durable_storage_unavailable");
  }
  const offlineAssets = offlineAssetsAssurance({
    missing,
    swMismatch,
    entries,
    expectedDigests: probe.expectedDigests,
    reasons,
  } satisfies OfflineAssetsAssuranceInput);
  const mayClaimOfflineReady =
    offlineAssets === "verified_ready" &&
    durable !== "unavailable" &&
    !swMismatch &&
    missing === 0;

  return {
    mode,
    offlineAssets,
    durableStorage: durable,
    entries,
    swMismatch,
    reasons,
    mayClaimOfflineReady,
  };
}

/**
 * In-memory cache of required module digests for enrollment (browser or test).
 * Does not claim network success; only records what was put.
 */
type PrefetchResult = Readonly<{ cached: string[]; failed: string[] }>;
type ModuleDigestSnapshot = Readonly<Record<string, string>>;

export class DuressOfflineAssetCache {
  readonly #entries = new Map<string, { digest: string; bytes: Uint8Array }>();

  put(capabilityId: string, digest: string, bytes: Uint8Array): void {
    this.#entries.set(capabilityId, { digest, bytes: bytes.slice() });
  }

  has(capabilityId: string): boolean {
    return this.#entries.has(capabilityId);
  }

  digest(capabilityId: string): string | null {
    return this.#entries.get(capabilityId)?.digest ?? null;
  }

  clear(): void {
    this.#entries.clear();
  }

  snapshot(): ModuleDigestSnapshot {
    return Object.fromEntries(
      [...this.#entries.entries()].map(([id, entry]) => [id, entry.digest]),
    ) satisfies ModuleDigestSnapshot;
  }

  /**
   * Prefetch admitted modules into the cache. `loader` must return real bytes —
   * empty stubs are rejected.
   */
  async prefetch(
    mode: DuressFeatureMode,
    loader: (
      cap: DuressCapability,
    ) => Promise<Readonly<{ digest: string; bytes: Uint8Array }>>,
  ): Promise<PrefetchResult> {
    const cached: string[] = [];
    const failed: string[] = [];
    if (mode === "off") {
      return { cached, failed } satisfies PrefetchResult;
    }

    for (const cap of capabilitiesForMode(mode).filter(
      (c) => c.kind !== "ui",
    )) {
      try {
        const { digest, bytes } = await loader(cap);
        if (!digest || bytes.byteLength === 0) {
          failed.push(cap.id);
          continue;
        }
        this.put(cap.id, digest, bytes);
        cached.push(cap.id);
      } catch {
        failed.push(cap.id);
      }
    }
    return { cached, failed } satisfies PrefetchResult;
  }
}
