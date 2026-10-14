/** Exact bounded browser physical namespace DATA; no owner, Root or factor authorization. */
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { assertUnambiguousJson } from "../lib/retired-credentials/json-preflight.js";
const originalTombPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
function unavailable(): never {
  throw new Error("Original browser vault state is unavailable.");
}
/** Retains the original regex and primitive-string acceptance, without loading a general schema runtime. */
export function readBrowserPhysicalTombData(input: BoundaryValue): string {
  if (!isString(input) || !originalTombPattern.test(input)) unavailable();
  return input;
}
export function readBrowserPhysicalRegistryData(
  wire: string | null,
): readonly string[] {
  if (wire === null) return [];
  assertUnambiguousJson(wire, 32768);
  const value: BoundaryValue = JSON.parse(wire);
  if (
    !isJsonObject(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "v") ||
    !Object.hasOwn(value, "tombs") ||
    value.v !== 1 ||
    !Array.isArray(value.tombs) ||
    value.tombs.length > 32
  )
    unavailable();
  const names = value.tombs.map(readBrowserPhysicalTombData);
  if (new Set(names).size !== names.length) unavailable();
  return Object.freeze(names.sort());
}
