/**
 * GF(256) under the Rijndael polynomial x^8 + x^4 + x^3 + x + 1, and Lagrange
 * interpolation over it, as SLIP-0039 fixes them. Shamir's scheme runs on each
 * byte of a secret separately.
 *
 * The tables are built on first use, not at import: a module has no top-level
 * work (`apps/pages/src/modules/README.md`).
 */

import { Slip39Error } from "./errors.js";

type Tables = Readonly<{ exp: Uint8Array; log: Uint8Array }>;

let cached: Tables | undefined;

function tables(): Tables {
  if (cached) return cached;
  const exp = new Uint8Array(255);
  const log = new Uint8Array(256);
  let poly = 1;
  for (let i = 0; i < 255; i += 1) {
    exp[i] = poly;
    log[poly] = i;
    // Multiply by x + 1, then reduce by the Rijndael polynomial.
    poly = (poly << 1) ^ poly;
    if (poly & 0x100) poly ^= 0x11b;
  }
  cached = { exp, log };
  return cached;
}

/** One share: its x coordinate and one y byte per secret byte. */
export type Point = Readonly<{ x: number; y: Uint8Array }>;

function checkPoints(points: readonly Point[]): number {
  const first = points[0];
  if (!first) throw new Slip39Error("no shares to interpolate");
  if (new Set(points.map((p) => p.x)).size !== points.length) {
    throw new Slip39Error("share indices must be unique");
  }
  if (points.some((p) => p.y.length !== first.y.length)) {
    throw new Slip39Error("all share values must have the same length");
  }
  return first.y.length;
}

/**
 * f(x) for the polynomial through `points`, computed per byte. Mirrors the
 * reference implementation: the Lagrange basis is evaluated in the log domain.
 */
export function interpolate(points: readonly Point[], x: number): Uint8Array {
  const length = checkPoints(points);
  const hit = points.find((p) => p.x === x);
  if (hit) return hit.y.slice();
  const { exp, log } = tables();
  let logProduct = 0;
  for (const p of points) logProduct += log[p.x ^ x] ?? 0;
  const result = new Uint8Array(length);
  for (const p of points) {
    let denominator = 0;
    for (const other of points) denominator += log[p.x ^ other.x] ?? 0;
    const numerator = logProduct - (log[p.x ^ x] ?? 0);
    const logBasis = (((numerator - denominator) % 255) + 255) % 255;
    for (let k = 0; k < length; k += 1) {
      const y = p.y[k] ?? 0;
      if (y !== 0) {
        result[k] =
          (result[k] ?? 0) ^ (exp[((log[y] ?? 0) + logBasis) % 255] ?? 0);
      }
    }
  }
  return result;
}
