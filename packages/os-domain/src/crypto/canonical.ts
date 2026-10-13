import {
  type BoundaryValue,
  type Jsonable,
  type MutableBoundaryObject,
  isFunction,
  isTypeofObject,
  overlapCast,
} from "../json.js";

/**
 * Stable JSON canonicalization for manifest digests.
 * Object keys sorted recursively; arrays preserve order.
 */
export function canonicalize(value: BoundaryValue): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: BoundaryValue): BoundaryValue {
  if (value === null || !isTypeofObject(value)) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  // Classify once, in the original position before arrays and toJSON.
  const isMap = value instanceof Map;
  if (!isMap) {
    if (Array.isArray(value)) {
      return value.map(sortKeys);
    }
    const proto = Object.getPrototypeOf(value);
    const candidate: Jsonable = overlapCast(value);
    if (
      proto !== Object.prototype &&
      proto !== null &&
      isFunction(candidate.toJSON)
    ) {
      return sortKeys(candidate.toJSON());
    }
  }
  const obj: MutableBoundaryObject = overlapCast(value);
  const map: Map<PropertyKey, BoundaryValue> = overlapCast(value);
  // Preserve entry values captured before sorting. Object getters stay lazy.
  const members = isMap
    ? [...map.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)))
    : Object.keys(obj).sort();
  const out = new Map<string, BoundaryValue>();
  for (const member of members) {
    const pair: [PropertyKey, BoundaryValue] = isMap
      ? overlapCast(member)
      : [String(member), undefined];
    const [key, item] = pair;
    const name = String(key);
    if (out.has(name)) throw new Error("Ambiguous Map key.");
    out.set(name, sortKeys(isMap ? item : obj[name]));
  }
  // Native conversion defines ordinary own writable/configurable data members,
  // including __proto__, without invoking Object.prototype's setter.
  return Object.fromEntries(out);
}
