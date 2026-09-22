/**
 * Catalog graph checks: references, tiers, alternatives, cycles and depth.
 *
 * Split from `catalog.ts` so each file stays inside the 400-line budget;
 * the per-descriptor bounds live there, the cross-descriptor structure here.
 */
import { type Diagnostic, diagnostic, pushDiagnostic } from "./diagnostics.js";
import { compareIds, isUnitName } from "./ids.js";
import type { CapabilityDescriptor, CapabilityId } from "./types.js";

export const MAX_DEPENDENCY_DEPTH = 16;

function graphEdges(d: CapabilityDescriptor): CapabilityId[] {
  const out = new Set<CapabilityId>(d.dependencies);
  for (const slot of d.alternatives) for (const id of slot.oneOf) out.add(id);
  return [...out].sort(compareIds);
}

export function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

export function checkReferences(
  d: CapabilityDescriptor,
  path: string,
  index: ReadonlyMap<CapabilityId, CapabilityDescriptor>,
  diags: Diagnostic[],
): void {
  const refCheck = (id: CapabilityId, refPath: string): void => {
    const target = index.get(id);
    if (target === undefined) {
      pushDiagnostic(
        diags,
        diagnostic(
          "UNKNOWN_CAPABILITY",
          refPath,
          `\`${id}\` is not in the catalog`,
        ),
      );
      return;
    }
    if (id === d.id) {
      pushDiagnostic(
        diags,
        diagnostic("DEPENDENCY_CYCLE", refPath, `\`${id}\` refers to itself`),
      );
    }
    if (d.tier === "core" && target.tier === "optional") {
      pushDiagnostic(
        diags,
        diagnostic(
          "CORE_DEPENDS_ON_OPTIONAL",
          refPath,
          `core \`${d.id}\` may not depend on optional \`${id}\``,
        ),
      );
    }
  };
  if (hasDuplicates(d.dependencies)) {
    pushDiagnostic(
      diags,
      diagnostic("DUPLICATE_ID", `${path}.dependencies`, "dependencies repeat"),
    );
  }
  d.dependencies.forEach((id, i) => refCheck(id, `${path}.dependencies[${i}]`));
  const slots = new Set<string>();
  d.alternatives.forEach((slot, i) => {
    const slotPath = `${path}.alternatives[${i}]`;
    if (!isUnitName(slot.slot) || slots.has(slot.slot)) {
      pushDiagnostic(
        diags,
        diagnostic(
          "INVALID_ID",
          `${slotPath}.slot`,
          `slot \`${slot.slot}\` must be well-formed and unique`,
        ),
      );
    }
    slots.add(slot.slot);
    if (slot.oneOf.length === 0 || hasDuplicates(slot.oneOf)) {
      pushDiagnostic(
        diags,
        diagnostic(
          "INVALID_VALUE",
          `${slotPath}.oneOf`,
          "a slot needs at least one distinct option",
        ),
      );
    }
    slot.oneOf.forEach((id, j) => refCheck(id, `${slotPath}.oneOf[${j}]`));
  });
}

/**
 * Longest-path depth over the dependency graph; a cycle is reported once at
 * the lexicographically smallest capability on it. Iterative and bounded by
 * the catalog size.
 */
export function checkGraph(
  index: ReadonlyMap<CapabilityId, CapabilityDescriptor>,
  diags: Diagnostic[],
): void {
  const depth = new Map<CapabilityId, number>();
  const onStack = new Set<CapabilityId>();
  const cyclic = new Set<CapabilityId>();
  const visit = (id: CapabilityId): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (onStack.has(id)) {
      cyclic.add(id);
      return 0;
    }
    const d = index.get(id);
    if (d === undefined) return 0;
    onStack.add(id);
    let deepest = 0;
    for (const edge of graphEdges(d))
      deepest = Math.max(deepest, visit(edge) + 1);
    onStack.delete(id);
    depth.set(id, deepest);
    return deepest;
  };
  for (const id of [...index.keys()].sort(compareIds)) {
    const d = visit(id);
    if (d > MAX_DEPENDENCY_DEPTH) {
      pushDiagnostic(
        diags,
        diagnostic(
          "DEPENDENCY_DEPTH",
          `capabilities.${id}`,
          `dependency depth ${d} exceeds ${MAX_DEPENDENCY_DEPTH}`,
        ),
      );
    }
  }
  for (const id of [...cyclic].sort(compareIds)) {
    pushDiagnostic(
      diags,
      diagnostic(
        "DEPENDENCY_CYCLE",
        `capabilities.${id}`,
        `\`${id}\` is on a dependency cycle`,
      ),
    );
  }
}
