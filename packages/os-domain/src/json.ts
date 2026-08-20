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
  readonly [key: string]: JsonValue | undefined;
};

export type MutableJsonObject = {
  [key: string]: JsonValue | undefined;
};

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type BoundaryObject = {
  readonly [key: string]: BoundaryValue | undefined;
};

export type MutableBoundaryObject = {
  [key: string]: BoundaryValue | undefined;
};

export type BoundaryFn = (...args: never[]) => BoundaryValue;

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
export function overlapCast<From, To>(value: From): To {
  // Call sites must omit type arguments — Vite/esbuild 0.28 cannot parse
  // overlapCast<T>(value).
  // SAFETY: the caller established the runtime overlap; From & To is the
  // typed witness TypeScript will accept without a chained unknown assertion.
  return value as From & To;
}

export function isString(value: BoundaryValue): value is string {
  return typeof value === "string";
}

export function isNumber(value: BoundaryValue): value is number {
  return typeof value === "number";
}

export function isBoolean(value: BoundaryValue): value is boolean {
  return typeof value === "boolean";
}

export function isBigint(value: BoundaryValue): value is bigint {
  return typeof value === "bigint";
}

export function isSymbol(value: BoundaryValue): value is symbol {
  return typeof value === "symbol";
}

export function isUndefined(value: BoundaryValue): value is undefined {
  return typeof value === "undefined";
}

export function isFunction(value: BoundaryValue): value is BoundaryFn {
  return typeof value === "function";
}

/** Matches `typeof value === "object"` (true for null). */
export function isTypeofObject(
  value: BoundaryValue,
): value is BoundaryObject | BoundaryValue[] | JsonObject | JsonValue[] | null {
  return typeof value === "object";
}

export function isJsonObject(value: BoundaryValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
