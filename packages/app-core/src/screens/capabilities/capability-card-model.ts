/**
 * View-model logic for `CapabilityCard` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import type {
  CapabilityDescriptor,
  EgressDeclaration,
} from "@opensesame/capability-composition";

export function uiUnits(descriptor: CapabilityDescriptor): string {
  const units = descriptor.moduleIds
    .map((id) => id.slice(id.indexOf("/") + 1))
    .filter((unit) => unit !== "runtime" && unit !== "worker");
  return units.length > 0 ? units.join(", ") : descriptor.summary;
}

export function egressLine(egress: readonly EgressDeclaration[]): string {
  if (egress.length === 0) return "nothing leaves this device";
  return egress
    .map(
      (entry) =>
        `${entry.class} → ${entry.purpose}${entry.automatic ? " (on its own)" : " (when you act)"}`,
    )
    .join("; ");
}

export function dependencyLine(descriptor: CapabilityDescriptor): string {
  const slots = descriptor.alternatives.map(
    (slot) => `${slot.slot}: one of ${slot.oneOf.join(" / ")}`,
  );
  const all = [...descriptor.dependencies, ...slots];
  return all.length > 0 ? all.join("; ") : "none";
}
