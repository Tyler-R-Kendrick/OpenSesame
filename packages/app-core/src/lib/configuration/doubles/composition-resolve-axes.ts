/**
 * The per-capability axes the fixture resolver reasons over — test support.
 *
 * Standing under the instance policy (distributed / prohibited / listed),
 * standing under the installation's own selection, the closure of hard
 * dependencies and alternative slots, and consent coverage by exposure
 * digest. Each axis is its own claim and none implies another, which is the
 * point: `composition-resolve-double.ts` assembles them into a plan without
 * ever collapsing two reasons into one.
 */

import type {
  CapabilityCatalog,
  CapabilityDescriptor,
  CapabilityId,
  ConsentReceipt,
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

export type Axes = {
  permitted: boolean;
  required: boolean;
  selected: boolean;
  runtimeSupported: boolean;
  reasons: ReasonCode[];
};

export type AxesMap = ReadonlyMap<CapabilityId, Axes>;
export type DescriptorMap = ReadonlyMap<CapabilityId, CapabilityDescriptor>;

/** Where this capability stands with the instance — three separate facts. */
type Standing = Readonly<{
  distributed: boolean;
  prohibited: boolean;
  listed: boolean;
}>;

function standingOf(entry: CapabilityDescriptor, input: DoubleInput): Standing {
  const policy = input.policy;
  return {
    distributed: input.distributed.has(entry.id),
    prohibited: policy?.capabilities.prohibited.includes(entry.id) ?? false,
    listed:
      policy === null ||
      policy.capabilities.required.includes(entry.id) ||
      policy.capabilities.optional.includes(entry.id),
  };
}

function standingReasons(standing: Standing): ReasonCode[] {
  const reasons: ReasonCode[] = [];
  if (!standing.distributed) reasons.push("NOT_DISTRIBUTED");
  if (standing.prohibited) reasons.push("PROHIBITED_BY_INSTANCE");
  else if (!standing.listed) reasons.push("NOT_PERMITTED_BY_INSTANCE");
  return reasons;
}

function optionalAxes(entry: CapabilityDescriptor, input: DoubleInput): Axes {
  const { policy, selection } = input;
  const standing = standingOf(entry, input);
  const reasons = standingReasons(standing);
  const required = policy?.capabilities.required.includes(entry.id) ?? false;
  const accepted = selection?.acceptedRequired.includes(entry.id) ?? false;
  const selected =
    accepted || (selection?.selectedOptional.includes(entry.id) ?? false);
  if (required && !accepted) reasons.push("REQUIRED_NOT_ACCEPTED");
  else if (!selected) reasons.push("NOT_SELECTED");
  const runtimeSupported = !input.unsupported.has(entry.id);
  if (!runtimeSupported) reasons.push("UNSUPPORTED_RUNTIME");
  return {
    permitted: standing.distributed && standing.listed && !standing.prohibited,
    required,
    selected,
    runtimeSupported,
    reasons,
  };
}

export function axesOf(entry: CapabilityDescriptor, input: DoubleInput): Axes {
  if (entry.tier !== "core") return optionalAxes(entry, input);
  // As the resolver: an always-on capability (one with a module) that the
  // policy prohibits is withdrawn (ADR 0140). The double does not cascade
  // to dependents; the resolver's own tests pin that.
  if (
    entry.moduleIds.length > 0 &&
    input.policy?.capabilities.prohibited.includes(entry.id) === true
  ) {
    return {
      permitted: false,
      required: false,
      selected: false,
      runtimeSupported: true,
      reasons: ["PROHIBITED_BY_INSTANCE"],
    };
  }
  return {
    permitted: true,
    required: false,
    selected: true,
    runtimeSupported: true,
    reasons: ["CORE"],
  };
}

function conflictFor(
  root: CapabilityDescriptor,
  dep: CapabilityId,
  axes: AxesMap,
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

export type Closure = {
  members: CapabilityId[];
  conflicts: PlanConflict[];
};

function slotClosure(
  root: CapabilityDescriptor,
  axes: AxesMap,
  input: DoubleInput,
  out: Closure,
): void {
  for (const slot of root.alternatives) {
    const chosen = input.selection?.chosenAlternatives[slot.slot];
    if (!chosen || !slot.oneOf.includes(chosen)) {
      out.conflicts.push({
        code: "ALTERNATIVE_NOT_CHOSEN",
        capability: root.id,
        subject: slot.slot,
        message: `${root.title} needs one of ${slot.oneOf.join(", ")} for ${slot.slot}.`,
      });
      continue;
    }
    const conflict = conflictFor(root, chosen, axes, input);
    if (conflict)
      out.conflicts.push({ ...conflict, code: "ALTERNATIVE_NOT_ALLOWED" });
    else out.members.push(chosen);
  }
}

export function closureOf(
  root: CapabilityDescriptor,
  byId: DescriptorMap,
  axes: AxesMap,
  input: DoubleInput,
): Closure {
  const out: Closure = { members: [], conflicts: [] };
  for (const dep of root.dependencies) {
    const conflict = conflictFor(root, dep, axes, input);
    if (conflict) out.conflicts.push(conflict);
    else out.members.push(dep);
  }
  slotClosure(root, axes, input, out);
  return {
    members: out.members.filter((id) => byId.has(id)),
    conflicts: out.conflicts,
  };
}

/** Consent covers a capability only when the receipt bound its exposure. */
export function covered(
  id: CapabilityId,
  digest: string,
  input: DoubleInput,
): boolean {
  if (input.assumeConsent) return true;
  return input.receipt?.exposure[id] === digest;
}
