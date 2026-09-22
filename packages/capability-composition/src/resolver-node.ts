/**
 * Per-node plan evaluation: reasons, axes, activation and consent deltas
 * for one closure member. Split out so resolver.ts stays under the
 * 400-line module budget (ADR 0093).
 */
import type { CapabilityDescriptor } from "./descriptor.js";
import type { ReasonCode } from "./ids.js";
import type { Ceiling } from "./resolver-graph.js";
import {
  activationStatus,
  ceilingExcludes,
  compareStrings,
  hasModules,
  requiresConsent,
  supportsRuntime,
} from "./resolver-graph.js";
import type {
  ConsentDelta,
  PlanConflict,
  SelectedCapability,
} from "./resolver.js";

/** Everything evaluateNode needs from the half-built plan. */
export type NodeContext = {
  readonly wanted: ReadonlySet<string>;
  readonly optionalWanted: ReadonlySet<string>;
  readonly blockedByDeps: readonly string[];
  readonly prohibitedBy: ReadonlySet<string>;
  readonly ceiling: Ceiling;
  readonly shipped: ReadonlySet<string>;
  readonly shippedModules: ReadonlySet<string>;
  readonly runtime: ReadonlySet<CapabilityDescriptor["environments"][number]>;
  readonly consented: ReadonlySet<string>;
  readonly cached: ReadonlySet<string>;
};

/** One evaluated closure member plus its side-channel outputs. */
export type NodeEvaluation = {
  readonly entry: SelectedCapability;
  readonly conflicts: readonly PlanConflict[];
  readonly delta: ConsentDelta | undefined;
};

/** Evaluate one closure member against every state axis. */
export function evaluateNode(
  id: string,
  descriptor: CapabilityDescriptor,
  dependents: number,
  context: NodeContext,
): NodeEvaluation {
  const prohibitedBy = context.prohibitedBy;
  const blockedByDeps = [...context.blockedByDeps].sort(compareStrings);
  const permitted =
    prohibitedBy.size === 0 && !ceilingExcludes(context.ceiling, id);
  const explicitlyWanted =
    context.wanted.has(id) || context.optionalWanted.has(id) || dependents > 0;
  const supportedByRuntime = supportsRuntime(descriptor, context.runtime);
  const consentNeeded = requiresConsent(descriptor);
  const isConsented = context.consented.has(id);
  const consentSatisfied = !consentNeeded || isConsented;
  const availableInDistribution =
    context.shipped.has(id) && hasModules(descriptor, context.shippedModules);
  const isCached = context.cached.has(id);
  const reasons: ReasonCode[] = [];
  const nodeConflicts: PlanConflict[] = [];

  if (prohibitedBy.size > 0) {
    reasons.push("PROHIBITED_BY_INSTANCE");
    nodeConflicts.push({
      reasonCode: "PROHIBITED_BY_INSTANCE",
      capabilityId: id,
      detail: `prohibited by ${[...prohibitedBy].sort(compareStrings).join(", ")}`,
      provenance: [...prohibitedBy].sort(compareStrings).join(","),
    });
  } else if (blockedByDeps.length > 0) {
    reasons.push("DEPENDENCY_CONFLICT");
    nodeConflicts.push({
      reasonCode: "DEPENDENCY_CONFLICT",
      capabilityId: id,
      detail: `depends on blocked ${blockedByDeps.sort(compareStrings).join(", ")}`,
      provenance: "dependency-closure",
    });
  } else if (ceilingExcludes(context.ceiling, id)) {
    reasons.push(
      context.ceiling.explicit ? "DENIED_BY_WORKSPACE" : "NOT_SELECTED",
    );
    nodeConflicts.push({
      reasonCode: context.ceiling.explicit
        ? "DENIED_BY_WORKSPACE"
        : "NOT_SELECTED",
      capabilityId: id,
      detail: context.ceiling.explicit
        ? "not in the explicit allow set"
        : "not in the permitted set",
      provenance: context.ceiling.provenance,
    });
  } else if (!availableInDistribution) {
    reasons.push("NOT_DISTRIBUTED");
    nodeConflicts.push({
      reasonCode: "NOT_DISTRIBUTED",
      capabilityId: id,
      detail: "not shipped (or its modules are not) in this build",
      provenance: "distribution",
    });
  } else if (!supportedByRuntime) {
    reasons.push("UNSUPPORTED_RUNTIME");
    nodeConflicts.push({
      reasonCode: "UNSUPPORTED_RUNTIME",
      capabilityId: id,
      detail: `needs one of ${descriptor.environments.join(", ")}`,
      provenance: "runtime",
    });
  } else if (!consentSatisfied) {
    reasons.push("CONSENT_REQUIRED");
    nodeConflicts.push({
      reasonCode: "CONSENT_REQUIRED",
      capabilityId: id,
      detail: "declared privileges require consent",
      provenance: "declaredPrivileges",
    });
  }

  const delta =
    explicitlyWanted && consentNeeded
      ? { capabilityId: id, required: true, granted: isConsented }
      : undefined;
  const loaded =
    permitted &&
    availableInDistribution &&
    supportedByRuntime &&
    consentSatisfied &&
    blockedByDeps.length === 0;
  const activation = activationStatus({
    loaded,
    cached: isCached,
    selected: context.wanted.has(id) || context.optionalWanted.has(id),
    available: availableInDistribution,
    reload: descriptor.requiresDocumentReload,
    reasons,
  });
  const entry: SelectedCapability = {
    id,
    descriptorVersion: descriptor.descriptorVersion,
    stateAxes: {
      permitted,
      selected: explicitlyWanted,
      availableInDistribution,
      supportedByRuntime,
      consented: consentSatisfied,
      loaded,
    },
    reasonCodes: reasons,
    conflicts: nodeConflicts,
    activationStatus: activation,
    moduleIds: [...descriptor.moduleIds],
  };
  return { entry, conflicts: nodeConflicts, delta };
}
