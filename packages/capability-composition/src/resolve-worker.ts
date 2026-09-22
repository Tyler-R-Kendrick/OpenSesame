/**
 * Installation-wide worker selection: the single distributed variant that
 * satisfies every approved capability's worker-graph constraint, or a
 * `WORKER_GRAPH_UNAVAILABLE` conflict on each constrained capability.
 */
import { compareIds, sortIds } from "./ids.js";
import type {
  CapabilityDescriptor,
  CapabilityId,
  DistributionContract,
  PlanConflict,
  RuntimeFacts,
} from "./types.js";

export type WorkerSelection = Readonly<{
  variant: string | null;
  /** Constrained capabilities no single variant can serve together. */
  unavailable: ReadonlySet<CapabilityId>;
  conflicts: readonly PlanConflict[];
}>;

export function selectWorkerVariant(
  approved: Iterable<CapabilityId>,
  index: ReadonlyMap<CapabilityId, CapabilityDescriptor>,
  distribution: DistributionContract,
  facts: RuntimeFacts,
): WorkerSelection {
  const constrained = new Map<CapabilityId, string>();
  for (const id of approved) {
    const constraint = index.get(id)?.workerGraphConstraint;
    if (constraint !== undefined && constraint !== null)
      constrained.set(id, constraint);
  }
  if (constrained.size === 0)
    return { variant: null, unavailable: new Set(), conflicts: [] };
  const constraints = sortIds(constrained.values());
  const matching = facts.serviceWorkerAvailable
    ? distribution.workerVariants.filter((v) =>
        constraints.every((c) => v.satisfies.includes(c)),
      )
    : [];
  if (matching.length > 0) {
    const tightest = [...matching].sort(
      (a, b) =>
        a.satisfies.length - b.satisfies.length || compareIds(a.id, b.id),
    )[0];
    return {
      variant: tightest === undefined ? null : tightest.id,
      unavailable: new Set(),
      conflicts: [],
    };
  }
  const unavailable = new Set(sortIds(constrained.keys()));
  const conflicts: PlanConflict[] = [...unavailable].map((id) => ({
    code: "WORKER_GRAPH_UNAVAILABLE",
    capability: id,
    subject: constrained.get(id) ?? "",
    message: facts.serviceWorkerAvailable
      ? `no distributed worker variant satisfies ${constraints.map((c) => `\`${c}\``).join(" + ")}`
      : "service workers are unavailable in this realm",
  }));
  return { variant: null, unavailable, conflicts };
}
