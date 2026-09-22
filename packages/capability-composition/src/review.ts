/**
 * Change review: what an after-plan does that a before-plan did not.
 *
 * `widened` is the monotonicity check a caller applies when it knows the
 * change was meant to tighten: it is true whenever any capability, module or
 * operation is approved after but was not before.
 */
import { normalizeEgress } from "./canonical.js";
import { indexCatalog } from "./catalog.js";
import { compareIds, sortIds } from "./ids.js";
import type {
  BrowserPermission,
  CapabilityCatalog,
  CapabilityId,
  CompositionChangeReview,
  EffectivePlan,
  EgressDeclaration,
} from "./types.js";

function difference(after: readonly string[], before: readonly string[]): string[] {
  const had = new Set(before);
  return sortIds(after.filter((id) => !had.has(id)));
}

function egressOf(
  plan: EffectivePlan,
  index: ReadonlyMap<CapabilityId, { egress: readonly EgressDeclaration[] }>,
): EgressDeclaration[] {
  return plan.approvedCapabilities.flatMap((id) => index.get(id)?.egress ?? []);
}

function permissionsOf(
  plan: EffectivePlan,
  index: ReadonlyMap<CapabilityId, { browserPermissions: readonly BrowserPermission[] }>,
): BrowserPermission[] {
  return plan.approvedCapabilities.flatMap((id) => index.get(id)?.browserPermissions ?? []);
}

export function reviewCompositionChange(
  before: EffectivePlan,
  after: EffectivePlan,
  catalog: CapabilityCatalog,
): CompositionChangeReview {
  const index = indexCatalog(catalog);
  const enabled = difference(after.approvedCapabilities, before.approvedCapabilities);
  const addedModules = difference(after.approvedModules, before.approvedModules);
  const addedOperations = difference(after.approvedOperations, before.approvedOperations);
  const beforeEgress = new Set(normalizeEgress(egressOf(before, index)).map((e) => JSON.stringify(e)));
  const addedEgress = normalizeEgress(egressOf(after, index)).filter(
    (e) => !beforeEgress.has(JSON.stringify(e)),
  );
  const beforePermissions = new Set(permissionsOf(before, index));
  const addedPermissions = [...new Set(permissionsOf(after, index))]
    .filter((p) => !beforePermissions.has(p))
    .sort(compareIds);
  const restartRequiredFor = sortIds(
    Object.values(after.capabilities)
      .filter((state) => state.restartRequired)
      .flatMap((state) => index.get(state.id)?.moduleIds ?? []),
  );
  return {
    before: before.identity,
    after: after.identity,
    enabled,
    disabled: difference(before.approvedCapabilities, after.approvedCapabilities),
    addedModules,
    removedModules: difference(before.approvedModules, after.approvedModules),
    addedOperations,
    removedOperations: difference(before.approvedOperations, after.approvedOperations),
    addedEgress: addedEgress.map((e) => ({
      class: e.class as EgressDeclaration["class"] /* SAFETY: normalizeEgress copies the class verbatim from EgressDeclaration values. */,
      purpose: e.purpose,
      automatic: e.automatic,
    })),
    addedPermissions,
    workerTransition:
      before.requiredWorkerVariant === after.requiredWorkerVariant
        ? null
        : { from: before.requiredWorkerVariant, to: after.requiredWorkerVariant },
    requiresDocumentReload: enabled.filter((id) => index.get(id)?.requiresDocumentReload === true),
    requiresNewArtifact: after.conflicts.some((c) => c.code === "WORKER_GRAPH_UNAVAILABLE"),
    restartRequiredFor,
    conflicts: after.conflicts,
    consent: after.consent,
    widened: enabled.length > 0 || addedModules.length > 0 || addedOperations.length > 0,
  };
}
