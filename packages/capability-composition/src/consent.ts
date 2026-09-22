/**
 * Consent: what a person accepted, and what is still owed.
 *
 * A receipt binds exact roots and the exposure digest of every capability in
 * the closure at acceptance time. Coverage is per capability and per digest:
 * a changed dependency, egress class or permission changes the digest, and
 * the capability drops back to `CONSENT_REQUIRED` until a new receipt names
 * the new digest.
 */
import { receiptDigest } from "./canonical.js";
import { indexCatalog } from "./catalog.js";
import { sortIds } from "./ids.js";
import { CONSENT_ONLY_REASONS } from "./reasons.js";
import type {
  CapabilityCatalog,
  CapabilityId,
  ConsentDelta,
  ConsentReceipt,
  EffectivePlan,
} from "./types.js";

/** The consentable closure: selected roots plus everything they pull in. */
export type ConsentCandidates = Readonly<{
  roots: readonly CapabilityId[];
  closure: readonly CapabilityId[];
}>;

export const EMPTY_CANDIDATES: ConsentCandidates = { roots: [], closure: [] };

/** A receipt counts only for the instance and installation it was written for. */
export function applicableReceipt(
  receipt: ConsentReceipt | null,
  instanceId: string,
  installationId: string,
): ConsentReceipt | null {
  if (receipt === null) return null;
  if (receipt.instanceId !== instanceId) return null;
  if (receipt.installationId !== installationId) return null;
  return receipt;
}

export function receiptCovers(
  receipt: ConsentReceipt | null,
  id: CapabilityId,
  digest: string,
): boolean {
  if (receipt === null) return false;
  return receipt.exposure[id] === digest;
}

export function consentDeltaFor(
  candidates: ConsentCandidates,
  digests: ReadonlyMap<CapabilityId, string>,
  receipt: ConsentReceipt | null,
  requiredNotAccepted: readonly CapabilityId[],
): ConsentDelta {
  const roots = new Set(candidates.roots);
  const receiptRoots = receipt === null ? [] : receipt.roots;
  const accepted = (id: CapabilityId): string | undefined =>
    receipt === null ? undefined : receipt.exposure[id];
  return {
    addedRoots: sortIds(
      candidates.roots.filter((id) => !receiptRoots.includes(id)),
    ),
    removedRoots: sortIds(receiptRoots.filter((id) => !roots.has(id))),
    changedExposure: sortIds(
      candidates.closure.filter((id) => {
        const was = accepted(id);
        return was !== undefined && was !== digests.get(id);
      }),
    ),
    addedDependencies: sortIds(
      candidates.closure.filter(
        (id) => !roots.has(id) && accepted(id) === undefined,
      ),
    ),
    requiredNotAccepted: sortIds(requiredNotAccepted),
  };
}

/**
 * Optional capabilities a plan would approve but for consent: approved
 * already, or held back only by `CONSENT_REQUIRED` / `RESTART_REQUIRED`.
 */
export function consentCandidatesOf(plan: EffectivePlan): ConsentCandidates {
  const closure: CapabilityId[] = [];
  const roots: CapabilityId[] = [];
  for (const id of sortIds(Object.keys(plan.capabilities))) {
    const state = plan.capabilities[id];
    if (state === undefined || state.tier !== "optional") continue;
    const consentable =
      state.approved ||
      (state.reasons.length > 0 &&
        state.reasons.every((r) => CONSENT_ONLY_REASONS.has(r)));
    if (!consentable) continue;
    closure.push(id);
    if (state.selected) roots.push(id);
  }
  return { roots, closure };
}

export function catalogDigests(
  catalog: CapabilityCatalog,
): ReadonlyMap<CapabilityId, string> {
  return new Map(catalog.capabilities.map((d) => [d.id, d.exposureDigest]));
}

/** The receipt a person signs for this plan: exact roots, exact digests. */
export function buildConsentReceipt(
  plan: EffectivePlan,
  catalog: CapabilityCatalog,
  acceptedAt: string,
): ConsentReceipt {
  const index = indexCatalog(catalog);
  const candidates = consentCandidatesOf(plan);
  const exposure: Record<CapabilityId, string> = {};
  for (const id of candidates.closure) {
    const descriptor = index.get(id);
    if (descriptor !== undefined) exposure[id] = descriptor.exposureDigest;
  }
  const body = {
    schemaVersion: 1 as const,
    instanceId: plan.identity.instanceId,
    installationId: plan.identity.installationId,
    policyRevision: plan.identity.policyRevision,
    selectionRevision: plan.identity.selectionRevision,
    acceptedAt,
    roots: candidates.roots,
    exposure,
  };
  return { ...body, receiptDigest: receiptDigest(body) };
}

/** What a given receipt still leaves owed for this plan. */
export function computeConsentDelta(
  plan: EffectivePlan,
  catalog: CapabilityCatalog,
  receipt: ConsentReceipt | null,
): ConsentDelta {
  const applicable = applicableReceipt(
    receipt,
    plan.identity.instanceId,
    plan.identity.installationId,
  );
  return consentDeltaFor(
    consentCandidatesOf(plan),
    catalogDigests(catalog),
    applicable,
    plan.consent.requiredNotAccepted,
  );
}
