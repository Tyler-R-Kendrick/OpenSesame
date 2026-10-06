/**
 * What the closed readers of a sealed plan body share: plain objects only,
 * exact key sets, and a title as one line of plain text. A reader built on
 * these refuses anything it did not write, and never throws.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
} from "@opensesame/os-domain";

const CONTROLS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** A title as it will be shown: one line of plain text, spaces collapsed. */
export function cleanTitle(line: string): string {
  return line.replace(CONTROLS, " ").replace(/\s+/gu, " ").trim();
}

/** A plain JSON object, or nothing: a class instance or a dressed prototype is not one. */
export function plainObject(value: BoundaryValue): JsonObject | null {
  if (!isJsonObject(value)) return null;
  const proto: object | null = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null ? value : null;
}

/** Whether `value` has exactly `keys`, no more and no fewer. */
export function hasExactKeys(
  value: JsonObject,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}
