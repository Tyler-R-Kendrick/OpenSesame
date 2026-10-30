/**
 * PBKDF2-HMAC-SHA256 for bare isolates with no host task scheduler.
 * Based on the @noble/hashes 1.8.0 PBKDF2 implementation (MIT); those
 * isolates previously yielded to a microtask every 10ms, not to a host task.
 * Where a host scheduler exists we use noble's maintained async PBKDF2.
 */
/*
The MIT License (MIT)

Copyright (c) 2022 Paul Miller (https://paulmillr.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
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
  let complete = false;
  try {
    prf = hmac.create(sha256, password);
    const keyed = prf;
    const salted = keyed.clone();
    try {
      salted.update(salt);
      let working = salted.clone();
      try {
        for (
          let block = 1, offset = 0;
          offset < length;
          block += 1, offset += HASH_BYTES
        ) {
          const target = output.subarray(offset, offset + HASH_BYTES);
          view.setUint32(0, block, false);
          working = salted._cloneInto(working);
          working.update(counter).digestInto(u);
          target.set(u.subarray(0, target.length));
          await mixRounds(iterations, () => {
            working = keyed._cloneInto(working);
            working.update(u).digestInto(u);
            for (let index = 0; index < target.length; index += 1)
              target[index] ^= u[index];
          });
        }
      } finally {
        working.destroy();
      }
    } finally {
      salted.destroy();
    }
    complete = true;
    return output;
  } finally {
    prf?.destroy();
    u.fill(0);
    counter.fill(0);
    if (!complete) output.fill(0);
  }
}

async function mixRounds(iterations: number, mix: () => void): Promise<void> {
  let lastYield = Date.now();
  for (let round = 1; round < iterations; round += 1) {
    mix();
    const elapsed = Date.now() - lastYield;
    if (elapsed >= 10 || elapsed < 0) {
      await Promise.resolve();
      lastYield = Date.now();
    }
  }
}
