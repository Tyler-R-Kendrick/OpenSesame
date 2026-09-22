/**
 * Browser-safe manifest digest (no node:crypto). Matches node sha256Hex output.
 */
import {
  type BoundaryValue,
  type JsonObject,
  type Jsonable,
  type MutableBoundaryObject,
  isFunction,
  isString,
  isTypeofObject,
  overlapCast,
} from "../json.js";

function u32At(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new Error("sha256 index out of range");
  }
  return value >>> 0;
}

function isJsonable(value: BoundaryValue): value is Jsonable {
  if (!isTypeofObject(value) || value === null) return false;
  const candidate: Jsonable = overlapCast(value);
  return isFunction(candidate.toJSON);
}

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
    const out: MutableBoundaryObject = {};
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
  const obj: MutableBoundaryObject = overlapCast(value);
  const out: MutableBoundaryObject = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortKeys(obj[key]);
  }
  return out;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256ExpandMessageSchedule(
  view: DataView,
  offset: number,
  w: Uint32Array,
): void {
  for (let j = 0; j < 16; j++) w[j] = view.getUint32(offset + j * 4, false);
  for (let j = 16; j < 64; j++) {
    const s0 =
      sha256Rotr(u32At(w, j - 15), 7) ^
      sha256Rotr(u32At(w, j - 15), 18) ^
      (u32At(w, j - 15) >>> 3);
    const s1 =
      sha256Rotr(u32At(w, j - 2), 17) ^
      sha256Rotr(u32At(w, j - 2), 19) ^
      (u32At(w, j - 2) >>> 10);
    w[j] = (u32At(w, j - 16) + s0 + u32At(w, j - 7) + s1) >>> 0;
  }
}

function sha256CompressBlock(H: Uint32Array, w: Uint32Array): void {
  let a = u32At(H, 0);
  let b = u32At(H, 1);
  let c = u32At(H, 2);
  let d = u32At(H, 3);
  let e = u32At(H, 4);
  let f = u32At(H, 5);
  let g = u32At(H, 6);
  let h = u32At(H, 7);
  for (let j = 0; j < 64; j++) {
    const S1 = sha256Rotr(e, 6) ^ sha256Rotr(e, 11) ^ sha256Rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + u32At(SHA256_K, j) + u32At(w, j)) >>> 0;
    const S0 = sha256Rotr(a, 2) ^ sha256Rotr(a, 13) ^ sha256Rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  H[0] = (u32At(H, 0) + a) >>> 0;
  H[1] = (u32At(H, 1) + b) >>> 0;
  H[2] = (u32At(H, 2) + c) >>> 0;
  H[3] = (u32At(H, 3) + d) >>> 0;
  H[4] = (u32At(H, 4) + e) >>> 0;
  H[5] = (u32At(H, 5) + f) >>> 0;
  H[6] = (u32At(H, 6) + g) >>> 0;
  H[7] = (u32At(H, 7) + h) >>> 0;
}

/** Minimal sync SHA-256 (public domain style) for browser digests. */
function sha256Bytes(message: Uint8Array): Uint8Array {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const l = message.length;
  const bitLen = l * 8;
  const withPad = (l + 9 + 63) & ~63;
  const buf = new Uint8Array(withPad);
  buf.set(message);
  buf[l] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(withPad - 4, bitLen >>> 0, false);
  view.setUint32(withPad - 8, Math.floor(bitLen / 0x100000000), false);

  const w = new Uint32Array(64);
  for (let i = 0; i < withPad; i += 64) {
    sha256ExpandMessageSchedule(view, i, w);
    sha256CompressBlock(H, w);
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, u32At(H, i), false);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function sha256Hex(data: string | Uint8Array): string {
  const bytes = isString(data) ? new TextEncoder().encode(data) : data;
  return `sha256:${toHex(sha256Bytes(bytes))}`;
}

export function digestManifest(manifest: JsonObject): string {
  return sha256Hex(canonicalize(manifest));
}
