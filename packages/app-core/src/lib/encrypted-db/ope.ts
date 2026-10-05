/**
 * Order-preserving encryption for the `order` layer (ADR 0173), after
 * Boldyreva, Chenette, Lee and O'Neill (2009).
 *
 * `opeEncrypt(m) < opeEncrypt(n)` exactly when `m < n`, so IndexedDB's own
 * key order answers a range query over ciphertexts. Each domain value owns a
 * pseudorandom sub-interval of a range 2^32 times as wide; the recursion
 * below finds it by halving the range and asking a PRF how many domain
 * points fall in the lower half.
 *
 * Differences from the paper, all of which keep the function deterministic
 * and order-preserving and none of which can be checked by a ciphertext:
 *
 * - The split is the hypergeometric distribution the paper samples, drawn
 *   exactly by sequential draws while at most `EXACT_DRAWS` points remain and
 *   from an Irwin-Hall approximation of its normal limit above that. Both use
 *   integers only, so no browser's `Math.log` can move a ciphertext.
 * - The PRF is HMAC-SHA-256 in counter mode, keyed per column and domain.
 *
 * What it reveals is what OPE reveals: the order of the values and, over a
 * dense domain, roughly the values (Naveed, Kamara and Wright 2015). It is
 * off unless a column asks for it. A ciphertext is not decryptable and is
 * never the only copy of a value: the row carries the value under the seal.
 */

import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";

/** The widest domain, in bits: millisecond times for the next 8,900 years. */
export const OPE_MAX_DOMAIN_BITS = 48;

/** How much wider than the domain the ciphertext range is, in bits. */
export const OPE_EXPANSION_BITS = 32;

/** Below this many points a split is drawn exactly. */
const EXACT_DRAWS = 64n;

const TWO_32 = 1n << 32n;

/** Bits a domain of `size` values needs. */
export function domainBits(size: bigint): number {
  return size <= 1n ? 1 : (size - 1n).toString(2).length;
}

/** The ciphertext's width in lowercase hex digits. */
export function opeHexWidth(size: bigint): number {
  return Math.ceil((domainBits(size) + OPE_EXPANSION_BITS) / 4);
}

function integerSqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

function u96(n: bigint): Uint8Array {
  const out = new Uint8Array(12);
  let rest = n;
  for (let i = 11; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  return n;
}

/** A stream of pseudorandom 128-bit integers for one node of the recursion. */
class Coins {
  private block = 0;
  private pending: bigint[] = [];

  constructor(
    private readonly key: Uint8Array,
    private readonly label: Uint8Array,
  ) {}

  next128(): bigint {
    const ready = this.pending.pop();
    if (ready !== undefined) return ready;
    const input = new Uint8Array(this.label.length + 4);
    input.set(this.label);
    new DataView(input.buffer).setUint32(this.label.length, this.block++);
    const out = hmac(sha256, this.key, input);
    this.pending.push(bytesToBigInt(out.subarray(16)));
    return bytesToBigInt(out.subarray(0, 16));
  }

  /** Uniform in [0, n) for n up to 2^96; the modulo bias is below 2^-32. */
  below(n: bigint): bigint {
    return this.next128() % n;
  }

  /** The sum of twelve uniform 32-bit integers: Irwin-Hall, variance 2^64. */
  irwinHall(): bigint {
    let sum = 0n;
    for (let i = 0; i < 3; i++) {
      let word = this.next128();
      for (let j = 0; j < 4; j++) {
        sum += word & (TWO_32 - 1n);
        word >>= 32n;
      }
    }
    return sum;
  }
}

/**
 * How many of `d` domain points fall in the lower half of a range of `r`
 * values (r even, d <= r): the hypergeometric draw of the paper.
 */
function splitPoints(coins: Coins, d: bigint, r: bigint): bigint {
  const lower = r / 2n;
  const low = d > r - lower ? d - (r - lower) : 0n;
  const high = d < lower ? d : lower;
  if (low === high) return low;
  let x: bigint;
  if (d <= EXACT_DRAWS) {
    x = 0n;
    let lowerLeft = lower;
    let total = r;
    for (let i = 0n; i < d; i++) {
      if (coins.below(total) < lowerLeft) {
        x += 1n;
        lowerLeft -= 1n;
      }
      total -= 1n;
    }
    return x;
  }
  // Mean d/2, variance d(r-d)/(4(r-1)): the normal limit, from integers.
  const spread = integerSqrt((d * (r - d)) / (r - 1n));
  x = d / 2n + ((coins.irwinHall() - 6n * TWO_32) * spread) / (2n * TWO_32);
  if (x < low) x = low;
  if (x > high) x = high;
  return x;
}

/**
 * Encrypt `m`, in [0, size), under `key`. The result is below
 * 2^(domainBits(size) + OPE_EXPANSION_BITS).
 */
export function opeEncrypt(key: Uint8Array, size: bigint, m: bigint): bigint {
  if (m < 0n || m >= size) throw new RangeError("value outside the domain");
  let dLow = 0n;
  let dHigh = size - 1n;
  let rLow = 0n;
  let rHigh = (1n << BigInt(domainBits(size) + OPE_EXPANSION_BITS)) - 1n;
  for (;;) {
    const d = dHigh - dLow + 1n;
    const r = rHigh - rLow + 1n;
    const label = new Uint8Array(24);
    label.set(u96(rLow));
    label.set(u96(rHigh), 12);
    const coins = new Coins(key, label);
    if (d === 1n) return rLow + coins.below(r);
    const lowerPoints = splitPoints(coins, d, r);
    const middle = rLow + r / 2n - 1n;
    if (m - dLow < lowerPoints) {
      dHigh = dLow + lowerPoints - 1n;
      rHigh = middle;
    } else {
      dLow += lowerPoints;
      rLow = middle + 1n;
    }
  }
}

/** The ciphertext as fixed-width lowercase hex, which sorts as it compares. */
export function opeHex(key: Uint8Array, size: bigint, m: bigint): string {
  return opeEncrypt(key, size, m).toString(16).padStart(opeHexWidth(size), "0");
}

/** The smallest and largest ciphertext hex of a domain, for open-ended ranges. */
export function opeHexBounds(size: bigint): readonly [string, string] {
  const width = opeHexWidth(size);
  return ["0".repeat(width), "f".repeat(width)];
}
