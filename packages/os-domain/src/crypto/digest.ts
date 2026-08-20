import { createHash } from "node:crypto";
import {
  isFunction,
  isString,
  isTypeofObject,
  overlapCast,
  type BoundaryObject,
  type BoundaryValue,
  type JsonObject,
} from "../json.js";

type Jsonable = { toJSON: () => BoundaryValue };

function isJsonable(value: BoundaryValue): value is Jsonable {
  if (!isTypeofObject(value) || value === null) return false;
  return isFunction(overlapCast(value).toJSON);
}

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
  if (value instanceof Map) {
    const out = {};
    const entries = [...value.entries()].sort(([a], [b]) =>
      String(a).localeCompare(String(b)),
    );
    for (const [key, item] of entries) {
      out[String(key)] = sortKeys(item);
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null && isJsonable(value)) {
    return sortKeys(value.toJSON());
  }
  const obj = overlapCast(value);
  const out = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortKeys(obj[key]);
  }
  return out;
}

export function sha256Hex(data: string | Uint8Array): string {
  const h = createHash("sha256");
  h.update(isString(data) ? Buffer.from(data, "utf8") : Buffer.from(data));
  return `sha256:${h.digest("hex")}`;
}

export function digestManifest(manifest: JsonObject): string {
  return sha256Hex(canonicalize(manifest));
}
