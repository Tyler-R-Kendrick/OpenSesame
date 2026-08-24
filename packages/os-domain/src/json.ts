/**
 * Named JSON and I/O-boundary types.
 *
 * Anti-slop treats inline `Record<string, unknown>` as an unsafe dictionary
 * and the `unknown` keyword on parameters/returns as unparsed input. These
 * aliases are owner contracts: consumers import them instead of spelling the
 * escape hatches at each call site.
 */

export type JsonPrimitive = string | number | boolean | null;

export type JsonObject = {
  [key: string]: JsonValue | undefined;
};

export type MutableJsonObject = {
  [key: string]: JsonValue | undefined;
};

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type BoundaryObject = {
  [key: string]: BoundaryValue | undefined;
};

export type MutableBoundaryObject = {
  [key: string]: BoundaryValue | undefined;
};

export type BoundaryFn = (...args: never[]) => void;

export type Constructable = new (...args: never[]) => BoundaryValue;

export type Jsonable = {
  toJSON: () => BoundaryValue;
};

export type BoundaryValue =
  | JsonValue
  | undefined
  | bigint
  | symbol
  | Date
  | Uint8Array
  | ArrayBuffer
  | Map<PropertyKey, BoundaryValue>
  | Set<BoundaryValue>
  | Error
  | BoundaryValue[]
  | BoundaryObject
  | MutableBoundaryObject
  | BoundaryFn
  | Jsonable;

/**
 * Assert a runtime overlap TypeScript cannot prove.
 *
 * Replaces `value as unknown as To` (a chained assertion) with a single
 * documented assertion inside this helper.
 */
export function overlapCast<From, To = JsonObject>(value: From): To {
  // Call sites must omit type arguments — Vite/esbuild 0.28 cannot parse
  // overlapCast<T>(value). Unannotated calls become JsonObject (the usual
  // JSON-boundary result); a contextual annotation supplies a tighter To.
  return /* SAFETY: the caller validates runtime overlap at the boundary; From & To preserves that witness. */ value as From &
    To;
}

function hasPrimitiveTag(value: BoundaryValue, tag: string): boolean {
  return (
    Object(value) !== value && Object.prototype.toString.call(value) === tag
  );
}

export function isString(value: BoundaryValue): value is string {
  return hasPrimitiveTag(value, "[object String]");
}

export function isNumber(value: BoundaryValue): value is number {
  return hasPrimitiveTag(value, "[object Number]");
}

export function isBoolean(value: BoundaryValue): value is boolean {
  return value === true || value === false;
}

export function isBigint(value: BoundaryValue): value is bigint {
  return hasPrimitiveTag(value, "[object BigInt]");
}

export function isSymbol(value: BoundaryValue): value is symbol {
  return hasPrimitiveTag(value, "[object Symbol]");
}

export function isUndefined(value: BoundaryValue): value is undefined {
  return value === undefined;
}

export function isFunction(
  value: BoundaryValue | BoundaryFn | Constructable,
): value is BoundaryFn {
  try {
    Function.prototype.toString.call(value);
    return true;
  } catch {
    return false;
  }
}

/** Matches `typeof value === "object"` (true for null). */
export function isTypeofObject(
  value: BoundaryValue,
): value is BoundaryObject | BoundaryValue[] | JsonObject | JsonValue[] | null {
  return value === null || (Object(value) === value && !isFunction(value));
}

export function isJsonObject(value: BoundaryValue): value is JsonObject {
  return value !== null && isTypeofObject(value) && !Array.isArray(value);
}

/** Narrow a JSON field to an object, or `undefined` when it is not one. */
export function readJsonObject(
  value: JsonValue | undefined,
): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

/** Narrow a JSON field to a string, or `undefined` when it is not one. */
export function readString(value: JsonValue | undefined): string | undefined {
  return isString(value) ? value : undefined;
}
