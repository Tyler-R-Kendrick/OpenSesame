/**
 * Re-export JSON boundary helpers for duress modules (anti-slop owner contracts).
 */
export {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  type MutableJsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
  readString,
} from "@opensesame/os-domain";

/** Membership test for frozen string-literal lists without widening casts. */
export function includesStringLiteral<T extends readonly string[]>(
  list: T,
  value: string,
): value is T[number] {
  for (const entry of list) {
    if (entry === value) return true;
  }
  return false;
}
