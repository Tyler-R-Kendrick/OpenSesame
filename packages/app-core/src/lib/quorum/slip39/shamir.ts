/**
 * Shamir's secret sharing as SLIP-0039 specifies it: the secret lives at
 * f(255) and a digest of it at f(254), so a wrong set of shares is caught
 * (the digest check) rather than silently producing a wrong secret.
 *
 * Threshold 1 is not shared at all: every share is the secret.
 */

import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { Slip39Error } from "./errors.js";
import { type Point, interpolate } from "./gf256.js";

export const SECRET_INDEX = 255;
export const DIGEST_INDEX = 254;
const DIGEST_LENGTH = 4;

export type RandomBytes = (length: number) => Uint8Array;

export const systemRandom: RandomBytes = (length) =>
  crypto.getRandomValues(new Uint8Array(length));

function digestOf(randomPart: Uint8Array, secret: Uint8Array): Uint8Array {
  return hmac(sha256, randomPart, secret).slice(0, DIGEST_LENGTH);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** SplitSecret(T, N, S): one point per share index 0..N-1. */
export function splitSecret(
  threshold: number,
  shareCount: number,
  secret: Uint8Array,
  random: RandomBytes = systemRandom,
): Point[] {
  if (threshold < 1 || threshold > shareCount || shareCount > 16) {
    throw new Slip39Error("0 < threshold <= share count <= 16 is required");
  }
  if (secret.length * 8 < 128 || secret.length % 2 !== 0) {
    throw new Slip39Error(
      "the secret must be at least 128 bits and a whole number of 16-bit words",
    );
  }
  if (threshold === 1) {
    return Array.from({ length: shareCount }, (_, x) => ({
      x,
      y: secret.slice(),
    }));
  }
  const randomShares: Point[] = Array.from(
    { length: threshold - 2 },
    (_, x) => ({ x, y: random(secret.length) }),
  );
  const randomPart = random(secret.length - DIGEST_LENGTH);
  const base: Point[] = [
    ...randomShares,
    { x: DIGEST_INDEX, y: concat(digestOf(randomPart, secret), randomPart) },
    { x: SECRET_INDEX, y: secret.slice() },
  ];
  const shares = [...randomShares];
  for (let x = threshold - 2; x < shareCount; x += 1) {
    shares.push({ x, y: interpolate(base, x) });
  }
  return shares;
}

/** RecoverSecret(T, shares): the secret, or a refusal if the digest fails. */
export function recoverSecret(
  threshold: number,
  shares: readonly Point[],
): Uint8Array {
  const first = shares[0];
  if (!first) throw new Slip39Error("no shares to recover from");
  if (threshold === 1) return first.y.slice();
  const secret = interpolate(shares, SECRET_INDEX);
  const digestShare = interpolate(shares, DIGEST_INDEX);
  const randomPart = digestShare.slice(DIGEST_LENGTH);
  const expected = digestOf(randomPart, secret);
  const actual = digestShare.slice(0, DIGEST_LENGTH);
  if (expected.some((byte, i) => byte !== actual[i])) {
    throw new Slip39Error("invalid digest of the shared secret");
  }
  return secret;
}
