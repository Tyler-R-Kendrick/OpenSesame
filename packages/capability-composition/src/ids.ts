/**
 * Identifier syntax for the four universes named in `types.ts`.
 *
 * Every predicate here is total over strings and never throws. Bounds are
 * part of the syntax: an id longer than its budget is not an id, however
 * well-formed its characters are.
 */
import type { CapabilityId, ModuleId } from "./types.js";

/** Longest accepted capability id, slot name, or worker-graph constraint. */
export const MAX_ID_LENGTH = 64;
/** Longest accepted module id (`<capability-id>/<unit>`). */
export const MAX_MODULE_ID_LENGTH = 129;
/** Longest accepted opaque identifier (instance, installation, vault). */
export const MAX_OPAQUE_ID_LENGTH = 128;
/** Longest accepted revision string. */
export const MAX_REVISION_LENGTH = 64;

const CAPABILITY_ID_RE = /^[a-z][a-z0-9]*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;
const UNIT_RE = /^[a-z][a-z0-9-]*$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9._:-]+$/;

/** `family.name[-name]`, e.g. `connectors.external`; at most 64 characters. */
export function isCapabilityId(v: string): boolean {
  return v.length <= MAX_ID_LENGTH && CAPABILITY_ID_RE.test(v);
}

/** A dependency slot or worker-graph constraint: `^[a-z][a-z0-9-]*$`, ≤ 64. */
export function isUnitName(v: string): boolean {
  return v.length > 0 && v.length <= MAX_ID_LENGTH && UNIT_RE.test(v);
}

/** `<capability-id>/<unit>` where the unit is `^[a-z][a-z0-9-]*$`. */
export function isModuleId(v: string): boolean {
  if (v.length > MAX_MODULE_ID_LENGTH) return false;
  const slash = v.indexOf("/");
  if (slash <= 0) return false;
  return isCapabilityId(v.slice(0, slash)) && isUnitName(v.slice(slash + 1));
}

/** The capability a module id belongs to, or `null` when it is not one. */
export function moduleCapability(v: ModuleId): CapabilityId | null {
  if (!isModuleId(v)) return null;
  return v.slice(0, v.indexOf("/"));
}

/** Instance, installation, and vault ids: `^[A-Za-z0-9._:-]+$`, 1–128. */
export function isOpaqueId(v: string): boolean {
  return (
    v.length > 0 && v.length <= MAX_OPAQUE_ID_LENGTH && OPAQUE_ID_RE.test(v)
  );
}

/** Locale-free, code-unit ordering so every sorted output is reproducible. */
export function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Unique, sorted copy of any id collection. */
export function sortIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort(compareIds);
}
