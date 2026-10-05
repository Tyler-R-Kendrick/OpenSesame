import {
  type BoundaryObject,
  type BoundaryValue,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import { CXF_EXTENSION } from "../../export/cxf.js";
import { toIso } from "../types.js";

/** Boundary readers shared by the CXF importer and its account mapping. */

export function obj(value: BoundaryValue): BoundaryObject | null {
  return isTypeofObject(value) && value !== null && !Array.isArray(value)
    ? overlapCast(value)
    : null;
}

export function arr(value: BoundaryValue): BoundaryValue[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: BoundaryValue): string {
  return isString(value) ? value : "";
}

/** An `EditableField`, or a bare string where an exporter took the shortcut. */
export function fieldValue(value: BoundaryValue) {
  if (isString(value)) return { text: value, hidden: false };
  const row = obj(value);
  if (row === null) return { text: "", hidden: false };
  return {
    text: str(row.value),
    hidden: str(row.fieldType) === "concealed-string",
  };
}

export function fieldLabel(value: BoundaryValue, fallback: string): string {
  const row = obj(value);
  const label = row === null ? "" : str(row.label);
  return label === "" ? fallback : label;
}

/** `creationAt`/`modifiedAt` are epoch seconds; `toIso` already handles both. */
export function timestamp(value: BoundaryValue): string | null {
  return isNumber(value) && value > 0 ? toIso(value) : null;
}

export function ourExtension(
  credential: BoundaryObject,
): BoundaryObject | null {
  for (const raw of arr(credential.extensions)) {
    const row = obj(raw);
    if (row !== null && str(row.name) === CXF_EXTENSION) return row;
  }
  return null;
}

export type Bucket = {
  /**
   * Every credential of a type, in document order. An account can carry
   * several (two passwords, two seeds, a key beside them), so only the places
   * that want one ask for the first.
   */
  byType: Map<string, BoundaryObject[]>;
  /** Custom-field credentials, which may appear more than once per item. */
  customFields: BoundaryObject[];
  unsupported: string[];
};

export function first(
  bucket: Bucket,
  type: string,
): BoundaryObject | undefined {
  return bucket.byType.get(type)?.[0];
}
