/**
 * Closure over selected roots.
 *
 * Each root is walked on its own: hard dependencies and the explicitly
 * chosen alternative for every slot. A dependency that is blocked, an
 * alternative that was not chosen, or a choice outside the slot's options
 * is a conflict *on the root*; a root with any conflict contributes nothing,
 * and a dependency is never enabled on a root's behalf. Nothing falls back.
 */
import { compareIds, sortIds } from "./ids.js";
import type { Axis } from "./resolve-axes.js";
import type {
  CapabilityDescriptor,
  CapabilityId,
  PlanConflict,
  ReasonCode,
} from "./types.js";

export type ClosureResult = Readonly<{
  /** Eligible members of every conflict-free root: the approval candidates. */
  members: ReadonlySet<CapabilityId>;
  /** Eligible members of any walked root, including roots that conflicted. */
  reached: ReadonlySet<CapabilityId>;
  /** id → direct dependents that named it, whether or not the edge held. */
  dependents: ReadonlyMap<CapabilityId, ReadonlySet<CapabilityId>>;
  /** root → its conflicts; absent for a clean root. */
  rootConflicts: ReadonlyMap<CapabilityId, readonly PlanConflict[]>;
}>;

type Walk = {
  readonly root: CapabilityId;
  readonly local: CapabilityId[];
  readonly conflicts: PlanConflict[];
  readonly visited: Set<CapabilityId>;
};

function dependencyConflictCode(blocked: readonly ReasonCode[]): PlanConflict["code"] {
  if (blocked.includes("NOT_DISTRIBUTED")) return "DEPENDENCY_NOT_DISTRIBUTED";
  if (blocked.includes("PROHIBITED_BY_INSTANCE")) return "DEPENDENCY_PROHIBITED";
  if (blocked.includes("NETWORK_POLICY_DENIES")) return "NETWORK_POLICY_DENIES";
  if (blocked.includes("WORKER_GRAPH_UNAVAILABLE")) return "WORKER_GRAPH_UNAVAILABLE";
  return "DEPENDENCY_NOT_PERMITTED";
}

function addDependent(
  dependents: Map<CapabilityId, Set<CapabilityId>>,
  id: CapabilityId,
  parent: CapabilityId,
): void {
  const set = dependents.get(id);
  if (set === undefined) dependents.set(id, new Set([parent]));
  else set.add(parent);
}

function visitEdge(
  walk: Walk,
  axes: ReadonlyMap<CapabilityId, Axis>,
  id: CapabilityId,
  kind: "dependency" | "alternative",
): CapabilityId | null {
  if (walk.visited.has(id)) return null;
  walk.visited.add(id);
  const axis = axes.get(id);
  if (axis === undefined) {
    walk.conflicts.push({
      code: kind === "dependency" ? "DEPENDENCY_NOT_DISTRIBUTED" : "ALTERNATIVE_NOT_ALLOWED",
      capability: walk.root,
      subject: id,
      message: `\`${id}\` is not in the catalog`,
    });
    return null;
  }
  if (axis.tier === "core") return null;
  if (axis.blocked.length > 0) {
    walk.conflicts.push({
      code: kind === "dependency" ? dependencyConflictCode(axis.blocked) : "ALTERNATIVE_NOT_ALLOWED",
      capability: walk.root,
      subject: id,
      message: `\`${id}\` is unavailable: ${axis.blocked.join(", ")}`,
    });
    return null;
  }
  walk.local.push(id);
  return id;
}

function visitAlternatives(
  walk: Walk,
  axes: ReadonlyMap<CapabilityId, Axis>,
  d: CapabilityDescriptor,
  chosen: Readonly<Record<string, CapabilityId>>,
  dependents: Map<CapabilityId, Set<CapabilityId>>,
  stack: CapabilityId[],
): void {
  const slots = [...d.alternatives].sort((a, b) => compareIds(a.slot, b.slot));
  for (const slot of slots) {
    const choice = chosen[slot.slot];
    if (choice === undefined) {
      walk.conflicts.push({
        code: "ALTERNATIVE_NOT_CHOSEN",
        capability: walk.root,
        subject: slot.slot,
        message: `\`${d.id}\` needs a choice for slot \`${slot.slot}\``,
      });
      continue;
    }
    if (!slot.oneOf.includes(choice)) {
      walk.conflicts.push({
        code: "ALTERNATIVE_NOT_ALLOWED",
        capability: walk.root,
        subject: choice,
        message: `\`${choice}\` is not an option for slot \`${slot.slot}\` of \`${d.id}\``,
      });
      continue;
    }
    addDependent(dependents, choice, d.id);
    const next = visitEdge(walk, axes, choice, "alternative");
    if (next !== null) stack.push(next);
  }
}

function walkRoot(
  root: CapabilityId,
  index: ReadonlyMap<CapabilityId, CapabilityDescriptor>,
  axes: ReadonlyMap<CapabilityId, Axis>,
  chosen: Readonly<Record<string, CapabilityId>>,
  dependents: Map<CapabilityId, Set<CapabilityId>>,
): Walk {
  const walk: Walk = { root, local: [root], conflicts: [], visited: new Set([root]) };
  const stack: CapabilityId[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    const d = index.get(current);
    if (d === undefined) continue;
    for (const dep of sortIds(d.dependencies)) {
      addDependent(dependents, dep, current);
      const next = visitEdge(walk, axes, dep, "dependency");
      if (next !== null) stack.push(next);
    }
    visitAlternatives(walk, axes, d, chosen, dependents, stack);
  }
  return walk;
}

export function computeClosure(
  index: ReadonlyMap<CapabilityId, CapabilityDescriptor>,
  axes: ReadonlyMap<CapabilityId, Axis>,
  roots: readonly CapabilityId[],
  chosen: Readonly<Record<string, CapabilityId>>,
): ClosureResult {
  const members = new Set<CapabilityId>();
  const reached = new Set<CapabilityId>();
  const dependents = new Map<CapabilityId, Set<CapabilityId>>();
  const rootConflicts = new Map<CapabilityId, readonly PlanConflict[]>();
  for (const root of sortIds(roots)) {
    const axis = axes.get(root);
    if (axis === undefined || axis.tier === "core" || axis.blocked.length > 0) continue;
    const walk = walkRoot(root, index, axes, chosen, dependents);
    for (const id of walk.local) reached.add(id);
    if (walk.conflicts.length === 0) {
      for (const id of walk.local) members.add(id);
    } else {
      rootConflicts.set(root, walk.conflicts);
    }
  }
  return { members, reached, dependents, rootConflicts };
}
