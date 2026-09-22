/**
 * Shared graph types and pure helpers for plan resolution. Split out so
 * resolver.ts stays under the 400-line module budget (ADR 0093).
 *
 * No I/O, no clock, no randomness: every function here is a pure function
 * of its arguments.
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import type {
  CapabilityDescriptor,
  ExecutionEnvironment,
} from "./descriptor.js";
import {
  type AllowSet,
  type InstallationSelectionDocument,
  type InstancePolicyDocument,
  type VaultRestrictionDocument,
} from "./documents.js";
import {
  validateInstallationSelection,
  validateInstancePolicy,
  validateVaultRestriction,
} from "./documents.js";
import type { ReasonCode } from "./ids.js";
import type {
  ActivationStatus,
  DistributionInventory,
  PlanConflict,
  ResolverInput,
  ResolverOutcome,
} from "./resolver.js";

/** A permitted-set ceiling plus the provenance that built it. */
export type Ceiling = {
  /** Explicit member ids, or the full universe when inheriting. */
  readonly ids: Map<string, "allow">;
  readonly explicit: boolean;
  readonly provenance: string;
};

/** Closure-graph node for one capability id. */
export type Node = {
  readonly id: string;
  /** Ancestors in the closure that discovered this node. */
  readonly dependents: Set<string>;
  /** Which documents prohibited this id. */
  readonly prohibitedBy: Set<string>;
  /** Blocking provenance: the ids of blocked (transitive) dependencies. */
  readonly blockedBy: Set<string>;
};

/** Record, per closure member, which documents prohibit it. */
export function markProhibited(
  closure: Map<string, Node>,
  policy: InstancePolicyDocument,
  vault: VaultRestrictionDocument | undefined,
  selection: InstallationSelectionDocument | undefined,
): void {
  const sources: ReadonlyArray<{ ids: readonly string[]; name: string }> = [
    { ids: policy.prohibited, name: "instance-policy" },
    ...(vault ? [{ ids: vault.prohibited, name: "vault-restriction" }] : []),
    ...(selection
      ? [{ ids: selection.prohibited, name: "installation-selection" }]
      : []),
  ];
  for (const { ids, name } of sources) {
    for (const id of ids) {
      closure.get(id)?.prohibitedBy.add(name);
    }
  }
}

/**
 * Report the blocked dependencies of one closure member (missing, prohibited
 * or transitively blocked). Memoizes per call-site map; cycle-safe via the
 * visiting set, so dependency cycles terminate.
 */
export function markBlockedFor(
  id: string,
  closure: Map<string, Node>,
  descriptors: Map<string, CapabilityDescriptor>,
): string[] {
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();
  const blocked = (current: string): boolean => {
    const known = memo.get(current);
    if (known !== undefined) return known;
    if (visiting.has(current)) return true;
    visiting.add(current);
    const node = closure.get(current);
    let isBlocked = node !== undefined && node.prohibitedBy.size > 0;
    const descriptor = descriptors.get(current);
    if (node !== undefined && descriptor !== undefined) {
      for (const dep of descriptor.dependencies) {
        const depNode = closure.get(dep);
        if (depNode === undefined) {
          if (!node.blockedBy.has(dep)) node.blockedBy.add(dep);
          isBlocked = true;
        } else if (blocked(dep)) {
          node.blockedBy.add(dep);
          isBlocked = true;
        }
      }
    }
    visiting.delete(current);
    memo.set(current, isBlocked);
    return isBlocked;
  };
  blocked(id);
  const node = closure.get(id);
  return node === undefined ? [] : [...node.blockedBy];
}

export function collect(
  root: string,
  descriptors: Map<string, CapabilityDescriptor>,
  closure: Map<string, Node>,
  conflicts: PlanConflict[],
): void {
  const path: string[] = [];
  const visit = (
    id: string,
    parent: string | undefined,
    seen: Set<string>,
  ): void => {
    if (seen.has(id)) {
      conflicts.push({
        reasonCode: "DEPENDENCY_CONFLICT",
        capabilityId: id,
        detail: `dependency cycle: ${[...path, id].join(" -> ")}`,
        provenance: "dependency-graph",
      });
      return;
    }
    const nextSeen = new Set(seen);
    nextSeen.add(id);
    path.push(id);
    let node = closure.get(id);
    if (node === undefined) {
      node = {
        id,
        dependents: new Set(),
        prohibitedBy: new Set(),
        blockedBy: new Set(),
      };
      closure.set(id, node);
      const descriptor = descriptors.get(id);
      if (descriptor !== undefined) {
        for (const dep of descriptor.dependencies) {
          if (!descriptors.has(dep)) {
            conflicts.push({
              reasonCode: "DEPENDENCY_CONFLICT",
              capabilityId: id,
              detail: `dependency ${dep} is not a known descriptor`,
              provenance: "distribution",
            });
            node.blockedBy.add(dep);
            continue;
          }
          visit(dep, id, nextSeen);
        }
      }
    }
    if (parent !== undefined) node.dependents.add(parent);
    path.pop();
  };
  visit(root, undefined, new Set());
}

export function permittedCeiling(
  policy: InstancePolicyDocument,
  vault: VaultRestrictionDocument | undefined,
  selection: InstallationSelectionDocument | undefined,
): Ceiling {
  const ids = new Map<string, "allow">();
  const provenances: string[] = ["instance-policy"];
  let explicit = false;
  if (vault && vault.allow !== "inherit") {
    explicit = true;
    provenances.push("vault-restriction.allow");
    for (const id of vault.allow.ids) ids.set(id, "allow");
  }
  if (selection && selection.allow !== "inherit") {
    explicit = true;
    provenances.push("installation-selection.allow");
    if (ids.size > 0) {
      for (const key of [...ids.keys()]) {
        if (!selection.allow.ids.includes(key)) ids.delete(key);
      }
    } else {
      for (const id of selection.allow.ids) ids.set(id, "allow");
    }
  }
  return { ids, explicit, provenance: provenances.join("+") };
}

export function ceilingExcludes(ceiling: Ceiling, id: string): boolean {
  if (!ceiling.explicit) return false;
  return !ceiling.ids.has(id);
}

export function idsOf(allow: AllowSet): readonly string[] {
  if (allow === "inherit") return [];
  return allow.ids;
}

export function union(...lists: readonly (readonly string[])[]): Set<string> {
  const out = new Set<string>();
  for (const list of lists) for (const item of list) out.add(item);
  return out;
}

export function hasModules(
  descriptor: CapabilityDescriptor,
  shippedModules: ReadonlySet<string>,
): boolean {
  return descriptor.moduleIds.every((m) => shippedModules.has(m));
}

export function supportsRuntime(
  descriptor: CapabilityDescriptor,
  runtime: ReadonlySet<ExecutionEnvironment>,
): boolean {
  return descriptor.environments.some((env) => runtime.has(env));
}

/** Consent is required when declared privileges are non-trivial. */
export function requiresConsent(descriptor: CapabilityDescriptor): boolean {
  const p = descriptor.declaredPrivileges;
  return (
    p.egressOrigins.length > 0 ||
    p.keyAccess.vaultRead ||
    p.keyAccess.vaultWrite ||
    p.keyAccess.deviceKeys ||
    p.browserPermissions.length > 0
  );
}

type ActivationInputs = {
  readonly loaded: boolean;
  readonly cached: boolean;
  readonly selected: boolean;
  readonly available: boolean;
  readonly reload: boolean;
  readonly reasons: readonly ReasonCode[];
};

export function activationStatus(inputs: ActivationInputs): ActivationStatus {
  if (inputs.reasons.includes("PROHIBITED_BY_INSTANCE")) return "disabled";
  if (!inputs.available) return "not-shipped";
  if (!inputs.selected) return "not-selected";
  if (inputs.loaded) {
    if (inputs.reload) return "restart-required";
    return inputs.cached ? "cached" : "active";
  }
  return "not-loaded";
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortConflicts(
  conflicts: readonly PlanConflict[],
): readonly PlanConflict[] {
  return [...conflicts].sort((a, b) => {
    const byId = compareStrings(a.capabilityId, b.capabilityId);
    if (byId !== 0) return byId;
    const byReason = compareStrings(a.reasonCode, b.reasonCode);
    if (byReason !== 0) return byReason;
    return compareStrings(a.detail, b.detail);
  });
}
