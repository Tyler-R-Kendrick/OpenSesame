import { createHash } from "node:crypto";

/**
 * Stable JSON canonicalization for manifest digests.
 * Object keys sorted recursively; arrays preserve order.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
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
  if (proto !== Object.prototype && proto !== null) {
    const toJSON = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof toJSON === "function") {
      return sortKeys(toJSON.call(value));
    }
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortKeys(obj[key]);
  }
  return out;
}

export function sha256Hex(data: string | Uint8Array): string {
  const h = createHash("sha256");
  h.update(
    typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data),
  );
  return `sha256:${h.digest("hex")}`;
}

export function digestManifest(manifest: Record<string, unknown>): string {
  return sha256Hex(canonicalize(manifest));
}
