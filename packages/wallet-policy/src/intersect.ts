/**
 * All-ancestor intersection: missing fields do not drop inherited limits.
 */

import { tighten } from "./compare.js";
import type {
  ConstraintKind,
  ConstraintSet,
  PolicyConstraint,
} from "./types.js";
import { CONSTRAINT_KINDS } from "./types.js";

export function indexByKind(
  constraints: readonly PolicyConstraint[],
): Map<ConstraintKind, PolicyConstraint> {
  const map = new Map<ConstraintKind, PolicyConstraint>();
  for (const constraint of constraints) {
    if (map.has(constraint.kind)) {
      throw new Error(
        `ConstraintSet carries duplicate kind ${constraint.kind}`,
      );
    }
    map.set(constraint.kind, constraint);
  }
  return map;
}

/**
 * Intersect ancestor constraint sets root→leaf.
 * A kind present on any ancestor remains; values tighten.
 * Incompatible same-kind windows (e.g. calendar ∩ fixed_interval) drop that kind
 * only when neither side is critical; if either is critical, throw.
 */
export function intersectAncestors(
  ancestors: readonly ConstraintSet[],
): ConstraintSet {
  if (ancestors.length === 0) {
    return { constraints: [] };
  }
  const acc = new Map<ConstraintKind, PolicyConstraint>();
  for (const set of ancestors) {
    for (const constraint of set.constraints) {
      const existing = acc.get(constraint.kind);
      if (existing === undefined) {
        acc.set(constraint.kind, constraint);
        continue;
      }
      const next = tighten(existing, constraint);
      if (next === null) {
        if (existing.critical || constraint.critical) {
          throw new Error(
            `Critical ${constraint.kind} constraints cannot be intersected`,
          );
        }
        acc.delete(constraint.kind);
        continue;
      }
      acc.set(constraint.kind, next);
    }
  }
  const constraints: PolicyConstraint[] = [];
  for (const kind of CONSTRAINT_KINDS) {
    const entry = acc.get(kind);
    if (entry !== undefined) {
      constraints.push(entry);
    }
  }
  return { constraints };
}
