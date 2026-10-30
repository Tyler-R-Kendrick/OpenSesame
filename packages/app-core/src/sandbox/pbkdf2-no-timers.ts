/**
 * PBKDF2-HMAC-SHA256 for bare isolates with no host task scheduler.
 * Based on the @noble/hashes 1.8.0 PBKDF2 implementation (MIT); those
 * isolates previously yielded to a microtask every 10ms, not to a host task.
 * Where a host scheduler exists we use noble's maintained async PBKDF2.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

const HASH_BYTES = 32;
const MAX_BLOCKS = 0xffffffff;

export async function pbkdf2WithoutTimers(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  length: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < 1 ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > MAX_BLOCKS * HASH_BYTES
  ) {
    throw new Error("Invalid PBKDF2 parameters");
  }
  const output = new Uint8Array(length);
  const counter = new Uint8Array(4);
  const view = new DataView(counter.buffer);
  const u = new Uint8Array(HASH_BYTES);
  let prf: ReturnType<typeof hmac.create> | undefined;
  let salted: ReturnType<typeof hmac.create> | undefined;
  let working: ReturnType<typeof hmac.create> | undefined;
  let complete = false;
  try {
    prf = hmac.create(sha256, password);
    salted = prf.clone();
    salted.update(salt);
    for (
      let block = 1, offset = 0;
      offset < length;
      block += 1, offset += HASH_BYTES
    ) {
      const target = output.subarray(offset, offset + HASH_BYTES);
      view.setUint32(0, block, false);
      working = salted._cloneInto(working).update(counter);
      working.digestInto(u);
      target.set(u.subarray(0, target.length));
      let lastYield = Date.now();
      for (let round = 1; round < iterations; round += 1) {
        working = prf._cloneInto(working).update(u);
        working.digestInto(u);
        for (let index = 0; index < target.length; index += 1)
          target[index] ^= u[index];
        const elapsed = Date.now() - lastYield;
        if (elapsed >= 10 || elapsed < 0) {
          await Promise.resolve();
          lastYield = Date.now();
        }
      }
    }
    complete = true;
    return output;
  } finally {
    prf?.destroy();
    salted?.destroy();
    working?.destroy();
    u.fill(0);
    counter.fill(0);
    if (!complete) output.fill(0);
  }
}
