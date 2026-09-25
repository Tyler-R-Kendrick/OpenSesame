/**
 * A small, honest resolver for the fixture catalog — test support only.
 *
 * It follows ownership.md §7's resolution semantics closely enough for the
 * UI suites: permitted, selected, closure with hard dependencies and
 * alternative slots, conflicts that fall on the root, consent coverage by
 * exposure digest, required roots that gate joining, restart when a module
 * was already evaluated. The axes themselves live in
 * `composition-resolve-axes.ts`; the real resolver lives in
 * `@opensesame/capability-composition`, and neither of these ever ships.
 */

import type {
  CapabilityId,
  CapabilityState,
  ConsentDelta,
  EffectivePlan,
  PlanConflict,
  PlanIdentity,
} from "@opensesame/capability-composition";
import {
  type Axes,
  type AxesMap,
  type DescriptorMap,
  type DoubleInput,
  axesOf,
  closureOf,
  covered,
} from "./composition-resolve-axes.js";

export type { DoubleInput } from "./composition-resolve-axes.js";

/** What one pass over the catalog decided, before states are written out. */
type ApprovalPass = {
  approved: Set<CapabilityId>;
  consentMissing: Set<CapabilityId>;
  dependencyOf: Map<CapabilityId, CapabilityId[]>;
  conflicts: PlanConflict[];
};

function admitClosure(
  root: CapabilityId,
  members: readonly CapabilityId[],
  byId: DescriptorMap,
  input: DoubleInput,
  pass: ApprovalPass,
): void {
  for (const id of [root, ...members]) {
    const digest = byId.get(id)?.exposureDigest ?? "";
    if (covered(id, digest, input)) pass.approved.add(id);
    else pass.consentMissing.add(id);
    if (id !== root)
      pass.dependencyOf.set(id, [...(pass.dependencyOf.get(id) ?? []), root]);
  }
}

function blocked(state: Axes, joinRefused: boolean): boolean {
  return (
    joinRefused ||
    !state.selected ||
    !state.permitted ||
    !state.runtimeSupported
  );
}

function approvalPass(
  input: DoubleInput,
  byId: DescriptorMap,
  axes: AxesMap,
  joinRefused: boolean,
): ApprovalPass {
  const pass: ApprovalPass = {
    approved: new Set(),
    consentMissing: new Set(),
    dependencyOf: new Map(),
    conflicts: [],
  };
  for (const entry of input.catalog.capabilities) {
    const state = axes.get(entry.id);
    if (!state) continue;
    if (entry.tier === "core") {
      if (state.permitted) pass.approved.add(entry.id);
      continue;
    }
    if (blocked(state, joinRefused)) continue;
    const closure = closureOf(entry, byId, axes, input);
    pass.conflicts.push(...closure.conflicts);
    if (closure.conflicts.length > 0) continue;
    admitClosure(entry.id, closure.members, byId, input, pass);
  }
  return pass;
}

function statesOf(
  input: DoubleInput,
  axes: AxesMap,
  pass: ApprovalPass,
): EffectivePlan["capabilities"] {
  const capabilities: Record<CapabilityId, CapabilityState> = {};
  for (const entry of input.catalog.capabilities) {
    const state = axes.get(entry.id);
    if (!state) continue;
    const isApproved = pass.approved.has(entry.id);
    const reasons = [...state.reasons];
    if (pass.consentMissing.has(entry.id)) reasons.push("CONSENT_REQUIRED");
    if (pass.conflicts.some((conflict) => conflict.capability === entry.id))
      reasons.push("DEPENDENCY_CONFLICT");
    const restartRequired =
      !isApproved &&
      entry.moduleIds.some((id) => input.evaluatedModuleIds.includes(id));
    if (restartRequired) reasons.push("RESTART_REQUIRED");
    capabilities[entry.id] = {
      id: entry.id,
      tier: entry.tier,
      distributed: entry.tier === "core" || input.distributed.has(entry.id),
      permitted: state.permitted,
      required: state.required,
      selected: state.selected,
      dependencyOf: pass.dependencyOf.get(entry.id) ?? [],
      runtimeSupported: state.runtimeSupported,
      approved: isApproved,
      restartRequired,
      reasons,
    };
  }
  return capabilities;
}

function consentOf(
  input: DoubleInput,
  pass: ApprovalPass,
  roots: readonly CapabilityId[],
  requiredNotAccepted: readonly CapabilityId[],
): ConsentDelta {
  return {
    addedRoots: roots.filter((id) => pass.consentMissing.has(id)),
    removedRoots: (input.receipt?.roots ?? []).filter(
      (id) => !roots.includes(id),
    ),
    changedExposure: [],
    addedDependencies: [...pass.consentMissing].filter(
      (id) => !roots.includes(id),
    ),
    requiredNotAccepted,
  };
}

function identityOf(
  input: DoubleInput,
  approvedList: readonly CapabilityId[],
): PlanIdentity {
  return {
    instanceId: input.policy?.instanceId ?? "personal-local",
    installationId: input.installationId,
    vaultId: input.vaultId,
    distributionId: "fixture",
    policyRevision: input.policy?.revision ?? "0",
    selectionRevision: input.selection?.revision ?? "0",
    planDigest: `sha256:plan-${approvedList.join(",")}`,
  };
}

/** Resolve the fixture's inputs to an `EffectivePlan`. */
export function resolveDouble(input: DoubleInput): EffectivePlan {
  const byId: DescriptorMap = new Map(
    input.catalog.capabilities.map((entry) => [entry.id, entry]),
  );
  const axes: AxesMap = new Map(
    input.catalog.capabilities.map((entry) => [entry.id, axesOf(entry, input)]),
  );
  const accepted = input.selection?.acceptedRequired ?? [];
  const requiredNotAccepted = (
    input.policy?.capabilities.required ?? []
  ).filter((id) => !accepted.includes(id));
  const pass = approvalPass(input, byId, axes, requiredNotAccepted.length > 0);
  const roots = input.selection
    ? [...accepted, ...input.selection.selectedOptional]
    : [];
  const approvedList = [...pass.approved].sort();
  const workerId = approvedList.find(
    (id) => byId.get(id)?.workerGraphConstraint,
  );
  return {
    identity: identityOf(input, approvedList),
    provenance: input.provenance,
    policyValid: true,
    capabilities: statesOf(input, axes, pass),
    approvedCapabilities: approvedList,
    approvedModules: approvedList
      .flatMap((id) => byId.get(id)?.moduleIds ?? [])
      .sort(),
    approvedOperations: approvedList
      .flatMap((id) => byId.get(id)?.operationIds ?? [])
      .sort(),
    approvedItemKinds: approvedList
      .flatMap((id) => byId.get(id)?.itemKinds ?? [])
      .sort(),
    requiredWorkerVariant: workerId
      ? (byId.get(workerId)?.workerGraphConstraint ?? null)
      : null,
    conflicts: pass.conflicts,
    consent: consentOf(input, pass, roots, requiredNotAccepted),
    network: input.policy?.network ?? {
      externalServices: "allow",
      allowedServiceOrigins: [],
    },
  };
}
