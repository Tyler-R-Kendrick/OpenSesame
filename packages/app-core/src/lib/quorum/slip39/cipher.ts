/**
 * Encryption of the master secret (SLIP-0039, "Encryption of the master
 * secret"): a four-round Feistel network whose round function is PBKDF2 with
 * HMAC-SHA256. It is a wide-block permutation, so a partial view of the shares
 * does not become a partial view of the secret.
 *
 * PBKDF2 runs in the platform's own implementation (`crypto.subtle`), which is
 * what makes 10 000 x 2^e iterations affordable in a browser tab.
 */

import { Slip39Error } from "./errors.js";

const ROUNDS = 4;
/** Iterations per round: 2500 << e, so 10 000 << e across the four rounds. */
const ROUND_ITERATIONS = 2500;
const SALT_PREFIX = "shamir";

/** The largest exponent the format can carry (4 bits). */
export const MAX_ITERATION_EXPONENT = 15;

const ASCII = new TextEncoder();

export function checkPassphrase(passphrase: string): Uint8Array {
  for (const ch of passphrase) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 126) {
      throw new Slip39Error("the passphrase must be printable ASCII (32-126)");
    }
  }
  return ASCII.encode(passphrase);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  return a.map((byte, i) => byte ^ (b[i] ?? 0));
}

function saltFor(identifier: number, extendable: boolean): Uint8Array {
  if (extendable) return new Uint8Array(0);
  return concat(
    ASCII.encode(SALT_PREFIX),
    Uint8Array.of((identifier >> 8) & 0xff, identifier & 0xff),
  );
}

async function round(
  index: number,
  passphrase: Uint8Array,
  exponent: number,
  salt: Uint8Array,
  r: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    concat(Uint8Array.of(index), passphrase),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: concat(salt, r),
      iterations: ROUND_ITERATIONS * 2 ** exponent,
    },
    key,
    r.length * 8,
  );
  return new Uint8Array(bits);
}

export type CipherParams = Readonly<{
  passphrase: string;
  iterationExponent: number;
  identifier: number;
  extendable: boolean;
  /** Refuse a share that asks for more work than this. */
  maxIterationExponent?: number | undefined;
}>;

async function feistel(
  input: Uint8Array,
  params: CipherParams,
  order: readonly number[],
): Promise<Uint8Array> {
  const limit = params.maxIterationExponent ?? MAX_ITERATION_EXPONENT;
  if (params.iterationExponent > limit) {
    throw new Slip39Error(
      `iteration exponent ${params.iterationExponent} exceeds the limit of ${limit}`,
    );
  }
  const passphrase = checkPassphrase(params.passphrase);
  const salt = saltFor(params.identifier, params.extendable);
  const half = input.length / 2;
  let left = input.slice(0, half);
  let right = input.slice(half);
  for (const i of order) {
    const f = await round(i, passphrase, params.iterationExponent, salt, right);
    [left, right] = [right, xor(left, f)];
  }
  return concat(right, left);
}

const FORWARD = Array.from({ length: ROUNDS }, (_, i) => i);
const BACKWARD = [...FORWARD].reverse();

export function encrypt(
  masterSecret: Uint8Array,
  params: CipherParams,
): Promise<Uint8Array> {
  return feistel(masterSecret, params, FORWARD);
}

export function decrypt(
  encryptedMasterSecret: Uint8Array,
  params: CipherParams,
): Promise<Uint8Array> {
  return feistel(encryptedMasterSecret, params, BACKWARD);
}
