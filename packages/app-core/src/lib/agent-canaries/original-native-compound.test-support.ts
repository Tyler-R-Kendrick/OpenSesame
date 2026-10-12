/** Faults follow real native AES or native JSON decode; they issue no authentication verdict. */
import { sealJson, vaultSealBinding } from "@opensesame/vault-core";
import { expect, vi } from "vitest";
import {
  type Fixture,
  keyOf,
  observe,
  rejected,
  verifyAll,
} from "./original-indexed-leaf.test-support.js";
import { captureOriginalCanaryIndexedSealData } from "./original-indexed-seal-data.js";
const nativeFill = Uint8Array.prototype.fill;
const binding = vaultSealBinding("compound", "controlled-canary");
function originalBuffer(f: Fixture, data: BufferSource) {
  if (!(data instanceof ArrayBuffer))
    throw new Error("Original native buffer missing.");
  const bytes = new Uint8Array(data);
  f.bytes.push(bytes);
  return bytes;
}
function installWipeRefusal<T>(f: Fixture, cause: T) {
  vi.spyOn(Uint8Array.prototype, "fill").mockImplementation(function (
    this: Uint8Array,
    value: number,
    start?: number,
    end?: number,
  ) {
    const selected =
      value === 0 && f.bytes.some((bytes) => bytes.buffer === this.buffer);
    const result = nativeFill.call(this, value, start, end);
    if (selected) throw cause;
    return result;
  });
}
async function verifyCompound<T, U, V>(
  f: Fixture,
  work: Promise<V>,
  first: T,
  cleanup: U,
) {
  const observed = await rejected(observe(f, work));
  if (!(observed.cause instanceof AggregateError))
    throw new Error("Independent native cleanup cause missing.");
  expect(observed.cause.errors).toHaveLength(2);
  expect(Object.is(observed.cause.errors[0], first)).toBe(true);
  expect(Object.is(observed.cause.errors[1], cleanup)).toBe(true);
  expect(f.bytes).toHaveLength(1);
  for (const bytes of f.bytes)
    expect([...bytes]).toEqual(new Array(bytes.length).fill(0));
  verifyAll(f);
}
export async function nativeEncryptAndWipe<T, U>(
  f: Fixture,
  first: T,
  cleanup: U,
) {
  const native = crypto.subtle.encrypt;
  vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (...args) => {
    originalBuffer(f, args[2]);
    await native.apply(crypto.subtle, args);
    throw first;
  });
  installWipeRefusal(f, cleanup);
  f.seal = captureOriginalCanaryIndexedSealData(() => {});
  await verifyCompound(
    f,
    f.seal.seal(keyOf(f), { controlled: "native encrypt" }, binding),
    first,
    cleanup,
  );
}
function recordNativeDecrypt(f: Fixture) {
  const native = crypto.subtle.decrypt;
  vi.spyOn(crypto.subtle, "decrypt").mockImplementation(async (...args) => {
    const result = await native.apply(crypto.subtle, args);
    originalBuffer(f, result);
    return result;
  });
}
export async function nativeAcceptAndDiscard<T, U>(
  f: Fixture,
  first: T,
  cleanup: U,
) {
  const original = await sealJson(
    keyOf(f),
    { controlled: "native discard" },
    binding,
  );
  recordNativeDecrypt(f);
  installWipeRefusal(f, cleanup);
  f.seal = captureOriginalCanaryIndexedSealData(() => {
    if (f.bytes.length) throw first;
  });
  await verifyCompound(
    f,
    f.seal.open(keyOf(f), original, binding),
    first,
    cleanup,
  );
}
export async function nativeDecodeAndWipe<T, U>(
  f: Fixture,
  first: T,
  cleanup: U,
) {
  const original = await sealJson(
    keyOf(f),
    { controlled: "native decoded work" },
    binding,
  );
  recordNativeDecrypt(f);
  const native = JSON.parse;
  const expected = JSON.stringify({ controlled: "native decoded work" });
  let decoded = false;
  vi.spyOn(JSON, "parse").mockImplementation((...args) => {
    const result = native(...args);
    if (args[0] === expected) decoded = true;
    return result;
  });
  installWipeRefusal(f, cleanup);
  f.seal = captureOriginalCanaryIndexedSealData(() => {
    if (decoded) throw first;
  });
  await verifyCompound(
    f,
    f.seal.open(keyOf(f), original, binding),
    first,
    cleanup,
  );
}
