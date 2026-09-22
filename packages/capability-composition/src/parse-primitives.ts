/**
 * Primitive value checks shared by the field readers.
 *
 * Each check receives a `Report` callback instead of the reader so this
 * module never imports `ObjectReader` and the dependency runs one way.
 */
import {
  type BoundaryValue,
  type JsonValue,
  isString,
} from "@opensesame/os-domain";
import type { DiagnosticCode } from "./diagnostics.js";
import { MAX_REVISION_LENGTH, isCapabilityId } from "./ids.js";

/** Longest list of ids any document may carry. */
export const MAX_LIST_IDS = 256;
/** Longest list of free-form strings (origins, constraints) a document may carry. */
export const MAX_STRING_LIST = 256;
export const MAX_ORIGIN_LENGTH = 256;

export type Report = (
  code: DiagnosticCode,
  path: string,
  message: string,
) => void;

export type StringBounds = Readonly<{
  min: number;
  max: number;
  pattern?: RegExp;
  code?: DiagnosticCode;
}>;

export const REVISION_BOUNDS: StringBounds = {
  min: 1,
  max: MAX_REVISION_LENGTH,
};

export function joinPath(base: string, key: string): string {
  return base === "" ? key : `${base}.${key}`;
}

export function indexPath(base: string, index: number): string {
  return `${base}[${index}]`;
}

export function checkString(
  report: Report,
  value: BoundaryValue,
  path: string,
  key: string,
  bounds: StringBounds,
): string | undefined {
  if (!isString(value)) {
    report("INVALID_TYPE", path, `\`${key}\` must be a string`);
    return undefined;
  }
  if (value.length < bounds.min || value.length > bounds.max) {
    report(
      bounds.code ?? "INVALID_LENGTH",
      path,
      `\`${key}\` must be ${bounds.min}–${bounds.max} characters`,
    );
    return undefined;
  }
  if (bounds.pattern !== undefined && !bounds.pattern.test(value)) {
    report(bounds.code ?? "INVALID_VALUE", path, `\`${key}\` is malformed`);
    return undefined;
  }
  return value;
}

export function checkIdList(
  report: Report,
  value: JsonValue,
  path: string,
  key: string,
): string[] | undefined {
  if (!Array.isArray(value)) {
    report("INVALID_TYPE", path, `\`${key}\` must be an array`);
    return undefined;
  }
  if (value.length > MAX_LIST_IDS) {
    report(
      "TOO_MANY_ITEMS",
      path,
      `\`${key}\` exceeds ${MAX_LIST_IDS} entries`,
    );
    return undefined;
  }
  const out: string[] = [];
  let valid = true;
  value.forEach((entry, index) => {
    const entryPath = indexPath(path, index);
    if (!isString(entry) || !isCapabilityId(entry)) {
      report(
        "INVALID_ID",
        entryPath,
        `entry in \`${key}\` is not a capability id`,
      );
      valid = false;
      return;
    }
    if (out.includes(entry)) {
      report("DUPLICATE_ID", entryPath, `\`${entry}\` repeats in \`${key}\``);
      valid = false;
      return;
    }
    out.push(entry);
  });
  return valid ? out : undefined;
}
