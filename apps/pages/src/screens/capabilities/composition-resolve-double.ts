/**
 * A small, honest resolver for the fixture catalog — test support only.
 *
 * It follows ownership.md §7's resolution semantics closely enough for the
 * UI suites: permitted, selected, closure with hard dependencies and
 * alternative slots, conflicts that fall on the root, consent coverage by
 * exposure digest, required roots that gate joining, restart when a module
 * was already evaluated. The real resolver lives in
 * `@opensesame/capability-composition`; this never ships.
 */

import type {
  CapabilityCatalog,
  CapabilityDescriptor,
  CapabilityId,
  CapabilityState,
  ConsentDelta,
  ConsentReceipt,
  EffectivePlan,
  InstallationCapabilitySelection,
  InstanceCapabilityPolicy,
  PlanConflict,
  PolicyProvenance,
  ReasonCode,
} from "@opensesame/capability-composition";

export type DoubleInput = Readonly<{
  catalog: CapabilityCatalog;
  policy: InstanceCapabilityPolicy | null;
  provenance: PolicyProvenance;
  distributed: ReadonlySet<CapabilityId>;
  unsupported: ReadonlySet<CapabilityId>;
  selection: InstallationCapabilitySelection | null;
  receipt: ConsentReceipt | null;
  /** True for a preview: consent is assumed so the reviewed plan is whole. */
  assumeConsent: boolean;
  evaluatedModuleIds: readonly string[];
  installationId: string;
  vaultId: string | null;
}>;

type Axes = {
  permitted: boolean;
  required: boolean;
  selected: boolean;
  runtimeSupported: boolean;
  reasons: ReasonCode[];
};

function axesOf(entry: CapabilityDescriptor, input: DoubleInput): Axes {
  const { policy, selection } = input;
  if (entry.tier === "core") {
    return {
      permitted: true,
      required: false,
      selected: true,
      runtimeSupported: true,
      reasons: ["CORE"],
    };
  }
  const reasons: ReasonCode[] = [];
  const distributed = input.distributed.has(entry.id);
  const prohibited =
    policy?.capabilities.prohibited.includes(entry.id) ?? false;
  const listed =
    policy === null ||
    policy.capabilities.required.includes(entry.id) ||
    policy.capabilities.optional.includes(entry.id);
  if (!distributed) reasons.push("NOT_DISTRIBUTED");
  if (prohibited) reasons.push("PROHIBITED_BY_INSTANCE");
  else if (!listed) reasons.push("NOT_PERMITTED_BY_INSTANCE");
  const required = policy?.capabilities.required.includes(entry.id) ?? false;
  const accepted = selection?.acceptedRequired.includes(entry.id) ?? false;
  const selected =
    accepted || (selection?.selectedOptional.includes(entry.id) ?? false);
  if (required && !accepted) reasons.push("REQUIRED_NOT_ACCEPTED");
  else if (!selected) reasons.push("NOT_SELECTED");
  const runtimeSupported = !input.unsupported.has(entry.id);
  if (!runtimeSupported) reasons.push("UNSUPPORTED_RUNTIME");
  return {
    permitted: distributed && listed && !prohibited,
    required,
    selected,
    runtimeSupported,
    reasons,
  };
}

function conflictFor(
  root: CapabilityDescriptor,
  dep: CapabilityId,
  axes: ReadonlyMap<CapabilityId, Axes>,
  input: DoubleInput,
): PlanConflict | null {
  const state = axes.get(dep);
  if (!state)
    return {
      code: "DEPENDENCY_NOT_DISTRIBUTED",
      capability: root.id,
      subject: dep,
      message: `${dep} is unknown.`,
    };
  if (!input.distributed.has(dep)) {
    return {
      code: "DEPENDENCY_NOT_DISTRIBUTED",
      capability: root.id,
      subject: dep,
      message: `${root.title} needs ${dep}, which this distribution does not contain.`,
    };
  }
  if (input.policy?.capabilities.prohibited.includes(dep)) {
    return {
      code: "DEPENDENCY_PROHIBITED",
      capability: root.id,
      subject: dep,
      message: `${root.title} needs ${dep}, which this instance prohibits.`,
    };
  }
  if (!state.permitted) {
    return {
      code: "DEPENDENCY_NOT_PERMITTED",
      capability: root.id,
      subject: dep,
      message: `${root.title} needs ${dep}, which this instance does not permit.`,
    };
  }
  return null;
}

function closureOf(
  root: CapabilityDescriptor,
  byId: ReadonlyMap<CapabilityId, CapabilityDescriptor>,
  axes: ReadonlyMap<CapabilityId, Axes>,
  input: DoubleInput,
): { members: CapabilityId[]; conflicts: PlanConflict[] } {
  const conflicts: PlanConflict[] = [];
  const members: CapabilityId[] = [];
  for (const dep of root.dependencies) {
    const conflict = conflictFor(root, dep, axes, input);
    if (conflict) conflicts.push(conflict);
    else members.push(dep);
  }
  for (const slot of root.alternatives) {
    const chosen = input.selection?.chosenAlternatives[slot.slot];
    if (!chosen || !slot.oneOf.includes(chosen)) {
      conflicts.push({
        code: "ALTERNATIVE_NOT_CHOSEN",
        capability: root.id,
        subject: slot.slot,
        message: `${root.title} needs one of ${slot.oneOf.join(", ")} for ${slot.slot}.`,
      });
      continue;
    }
    const conflict = conflictFor(root, chosen, axes, input);
    if (conflict)
      conflicts.push({ ...conflict, code: "ALTERNATIVE_NOT_ALLOWED" });
    else members.push(chosen);
  }
  return { members: members.filter((id) => byId.has(id)), conflicts };
}

function covered(
  id: CapabilityId,
  digest: string,
  input: DoubleInput,
): boolean {
  if (input.assumeConsent) return true;
  return input.receipt?.exposure[id] === digest;
}

/** Resolve the fixture's inputs to an `EffectivePlan`. */
export function resolveDouble(input: DoubleInput): EffectivePlan {
  const byId = new Map(
    input.catalog.capabilities.map((entry) => [entry.id, entry]),
  );
  const axes = new Map(
    input.catalog.capabilities.map((entry) => [entry.id, axesOf(entry, input)]),
  );
  const requiredNotAccepted = (
    input.policy?.capabilities.required ?? []
  ).filter((id) => !(input.selection?.acceptedRequired.includes(id) ?? false));
  const joinRefused = requiredNotAccepted.length > 0;
  const conflicts: PlanConflict[] = [];
  const approved = new Set<CapabilityId>();
  const dependencyOf = new Map<CapabilityId, CapabilityId[]>();
  const consentMissing = new Set<CapabilityId>();
  for (const entry of input.catalog.capabilities) {
    const state = axes.get(entry.id);
    if (!state) continue;
    if (entry.tier === "core") {
      approved.add(entry.id);
      continue;
    }
    if (
      joinRefused ||
      !state.selected ||
      !state.permitted ||
      !state.runtimeSupported
    )
      continue;
    const closure = closureOf(entry, byId, axes, input);
    conflicts.push(...closure.conflicts);
    if (closure.conflicts.length > 0) continue;
    for (const id of [entry.id, ...closure.members]) {
      const digest = byId.get(id)?.exposureDigest ?? "";
      if (covered(id, digest, input)) approved.add(id);
      else consentMissing.add(id);
      if (id !== entry.id)
        dependencyOf.set(id, [...(dependencyOf.get(id) ?? []), entry.id]);
    }
  }
  const capabilities: Record<CapabilityId, CapabilityState> = {};
  for (const entry of input.catalog.capabilities) {
    const state = axes.get(entry.id);
    if (!state) continue;
    const isApproved = approved.has(entry.id);
    const reasons = [...state.reasons];
    if (consentMissing.has(entry.id)) reasons.push("CONSENT_REQUIRED");
    if (conflicts.some((conflict) => conflict.capability === entry.id))
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
      dependencyOf: dependencyOf.get(entry.id) ?? [],
      runtimeSupported: state.runtimeSupported,
      approved: isApproved,
      restartRequired,
      reasons,
    };
  }
  const roots = input.selection
    ? [...input.selection.acceptedRequired, ...input.selection.selectedOptional]
    : [];
  const consent: ConsentDelta = {
    addedRoots: roots.filter((id) => consentMissing.has(id)),
    removedRoots: (input.receipt?.roots ?? []).filter(
      (id) => !roots.includes(id),
    ),
    changedExposure: [],
    addedDependencies: [...consentMissing].filter((id) => !roots.includes(id)),
    requiredNotAccepted,
  };
  const approvedList = [...approved].sort();
  const modules = approvedList.flatMap((id) => byId.get(id)?.moduleIds ?? []);
  const workerId = approvedList.find(
    (id) => byId.get(id)?.workerGraphConstraint,
  );
  return {
    identity: {
      instanceId: input.policy?.instanceId ?? "personal-local",
      installationId: input.installationId,
      vaultId: input.vaultId,
      distributionId: "fixture",
      policyRevision: input.policy?.revision ?? "0",
      selectionRevision: input.selection?.revision ?? "0",
      planDigest: `sha256:plan-${approvedList.join(",")}`,
    },
    provenance: input.provenance,
    policyValid: true,
    capabilities,
    approvedCapabilities: approvedList,
    approvedModules: modules.sort(),
    approvedOperations: approvedList
      .flatMap((id) => byId.get(id)?.operationIds ?? [])
      .sort(),
    approvedItemKinds: approvedList
      .flatMap((id) => byId.get(id)?.itemKinds ?? [])
      .sort(),
    requiredWorkerVariant: workerId
      ? (byId.get(workerId)?.workerGraphConstraint ?? null)
      : null,
    conflicts,
    consent,
    network: input.policy?.network ?? {
      externalServices: "allow",
      allowedServiceOrigins: [],
    },
  };
}
