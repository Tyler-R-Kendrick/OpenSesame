/** Existing registry/index parsing only; receives no owner or admission. */
import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
export type TombsRegistry = { v: 1; tombs: string[] };
export type TombIndex = { v: 1; files: Record<string, number> };
export function parseRegistry(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed) || !Array.isArray(parsed.tombs)) return [];
    return parsed.tombs.filter(isString);
  } catch {
    return [];
  }
}
export function parseIndex(value: BoundaryValue): TombIndex {
  if (!isJsonObject(value) || !isJsonObject(value.files))
    return { v: 1, files: {} };
  const files: Record<string, number> = {};
  for (const [path, rev] of Object.entries(value.files)) {
    if (isNumber(rev)) files[path] = rev;
  }
  return { v: 1, files };
}
