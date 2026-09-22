import type { CapabilityId } from "@opensesame/capability-composition";
import type { SourceClass, SourceClassification } from "./classification.js";

/** One rule, written compactly so an area file stays readable. */
export function rule(
  pattern: string,
  classification: SourceClass,
  capability: CapabilityId | null,
  rationale: string,
): SourceClassification {
  return { pattern, classification, capability, rationale };
}

export function core(
  pattern: string,
  capability: CapabilityId | null,
  rationale: string,
): SourceClassification {
  return rule(pattern, "core", capability, rationale);
}

export function shared(
  pattern: string,
  rationale: string,
): SourceClassification {
  return rule(pattern, "shared", null, rationale);
}

export function optional(
  pattern: string,
  capability: CapabilityId,
  rationale: string,
): SourceClassification {
  return rule(pattern, "optional", capability, rationale);
}

/** Several prefixes under one root, all owned the same way. */
export function each(
  root: string,
  names: readonly string[],
  make: (pattern: string) => SourceClassification,
): SourceClassification[] {
  return names.map((name) => make(`${root}${name}`));
}
