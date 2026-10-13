/** Real native AES remains the oracle under forged function binding and encrypted index boundaries. */
import { openJson, sealJson, vaultSealBinding } from "@opensesame/vault-core";
import { expect, it, vi } from "vitest";
import {
  canaryLogicalPath,
  indexedCanaryBlob,
  nextCanaryIndexData,
  readCanaryIndexData,
} from "./indexed-record-data.js";
import {
  type Fixture,
  keyOf,
  observe,
  originalSeal,
  owned,
  rejected,
  verifyAll,
} from "./original-indexed-leaf.test-support.js";
type NativeBindTarget =
  | Crypto["getRandomValues"]
  | SubtleCrypto["encrypt"]
  | SubtleCrypto["decrypt"];
const binding = vaultSealBinding("bounded", "index");
function forgeOwnBind(
  f: Fixture,
  method: NativeBindTarget,
  observer: () => void,
) {
  const original = Object.getOwnPropertyDescriptor(method, "bind");
  f.restores.push(() => {
    if (original) Object.defineProperty(method, "bind", original);
    else if (!Reflect.deleteProperty(method, "bind"))
      throw new Error("Original native bind descriptor did not restore.");
  });
  Object.defineProperty(method, "bind", {
    configurable: true,
    value: () => {
      observer();
      return () => {
        throw new Error("Forged fixed native dispatch ran.");
      };
    },
  });
}
async function intrinsicNativeBindings(f: Fixture) {
  let forgedBindings = 0;
  const observeBind = () => {
    ++forgedBindings;
  };
  forgeOwnBind(f, crypto.getRandomValues, observeBind);
  forgeOwnBind(f, crypto.subtle.encrypt, observeBind);
  forgeOwnBind(f, crypto.subtle.decrypt, observeBind);
  const seal = originalSeal(f);
  const key = keyOf(f);
  const value = { controlled: "native binding attack control" };
  const original = await sealJson(key, value, binding);
  expect(await seal.open(key, original, binding)).toEqual(value);
  const produced = await seal.seal(key, value, binding);
  expect(await openJson(key, produced, binding)).toEqual(value);
  expect(forgedBindings).toBe(0);
}
it("module-original intrinsic dispatch bypasses forged own bind while native random and both AES directions remain genuine", () =>
  owned(intrinsicNativeBindings));
function countOriginalEncrypt() {
  const native = crypto.subtle.encrypt;
  let calls = 0;
  vi.spyOn(crypto.subtle, "encrypt").mockImplementation((...args) => {
    ++calls;
    return native.apply(crypto.subtle, args);
  });
  return () => calls;
}
async function refuseBeforeNativeEncrypt<T>(
  f: Fixture,
  work: () => Promise<T>,
  count: () => number,
) {
  const before = count();
  await rejected(observe(f, work()));
  expect(count()).toBe(before);
}
async function fullIndexBoundary(f: Fixture) {
  const count = countOriginalEncrypt();
  const seal = originalSeal(f);
  const key = keyOf(f);
  const files: Record<string, number> = {};
  for (let i = 0; i < 128; ++i) files[`config/item-${i}`] = 1;
  const wire = JSON.stringify(await sealJson(key, { v: 1, files }, binding));
  const before = await readCanaryIndexData(
    "bounded",
    wire,
    key,
    seal,
    () => {},
  );
  const changed = await nextCanaryIndexData(
    "bounded",
    before,
    "config/item-0",
    key,
    seal,
    () => {},
  );
  const readable = await readCanaryIndexData(
    "bounded",
    changed,
    key,
    seal,
    () => {},
  );
  expect(readable.paths).toHaveLength(128);
  const decoded = await openJson(
    key,
    indexedCanaryBlob(changed, 2 << 20),
    binding,
  );
  expect(decoded).toEqual({ v: 1, files: { ...files, "config/item-0": 2 } });
  await refuseBeforeNativeEncrypt(
    f,
    () =>
      nextCanaryIndexData(
        "bounded",
        before,
        canaryLogicalPath("b".repeat(64)),
        key,
        seal,
        () => {},
      ),
    count,
  );
  const underWire = JSON.stringify(
    await sealJson(key, { v: 1, files: {} }, binding),
  );
  const under = await readCanaryIndexData(
    "bounded",
    underWire,
    key,
    seal,
    () => {},
  );
  expect(under.paths).toHaveLength(0);
  for (const path of ["../escape", "config/", `config/${"b".repeat(512)}`])
    await refuseBeforeNativeEncrypt(
      f,
      () => nextCanaryIndexData("bounded", under, path, key, seal, () => {}),
      count,
    );
  await refuseBeforeNativeEncrypt(
    f,
    () =>
      nextCanaryIndexData(
        "bounded",
        { ...before, index: { ...before.index, v: 2 } },
        "config/item-0",
        key,
        seal,
        () => {},
      ),
    count,
  );
  verifyAll(f);
}
it("a genuine128-row encrypted index updates existing rows but never encrypts a129th row or invalid path/version", () =>
  owned(fullIndexBoundary));
async function terminalRevisionBoundary(f: Fixture) {
  const count = countOriginalEncrypt();
  const seal = originalSeal(f);
  const key = keyOf(f);
  const files = { "config/counter": Number.MAX_SAFE_INTEGER - 2 };
  const wire = JSON.stringify(await sealJson(key, { v: 1, files }, binding));
  const before = await readCanaryIndexData(
    "bounded",
    wire,
    key,
    seal,
    () => {},
  );
  const changed = await nextCanaryIndexData(
    "bounded",
    before,
    "config/counter",
    key,
    seal,
    () => {},
  );
  const readable = await readCanaryIndexData(
    "bounded",
    changed,
    key,
    seal,
    () => {},
  );
  expect(
    await openJson(key, indexedCanaryBlob(changed, 2 << 20), binding),
  ).toEqual({ v: 1, files: { "config/counter": Number.MAX_SAFE_INTEGER - 1 } });
  await refuseBeforeNativeEncrypt(
    f,
    () =>
      nextCanaryIndexData(
        "bounded",
        readable,
        "config/counter",
        key,
        seal,
        () => {},
      ),
    count,
  );
  verifyAll(f);
}
it("last writable revision remains natively readable and further advancement refuses before actual encryption", () =>
  owned(terminalRevisionBoundary));
