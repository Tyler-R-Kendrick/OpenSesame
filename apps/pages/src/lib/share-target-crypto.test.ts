/** @vitest-environment node */
import { afterEach, expect, it, vi } from "vitest";
import {
  newShareTargetKey,
  openShareTarget,
  sealShareTarget,
} from "./share-target.js";

afterEach(() => vi.restoreAllMocks());

it("preserves the post-import plaintext semantics without a full-size copy", async () => {
  const key = newShareTargetKey();
  const backing = new Uint8Array([9, 1, 2, 9]);
  const plain = backing.subarray(1, 3);
  const originalImport = crypto.subtle.importKey.bind(crypto.subtle);
  const originalEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  let offered: BufferSource | undefined;
  vi.spyOn(crypto.subtle, "importKey").mockImplementationOnce(
    async (...args) => {
      const imported = await Reflect.apply(originalImport, crypto.subtle, args);
      backing[1] = 8;
      return imported;
    },
  );
  vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
    offered = args[2];
    return Reflect.apply(originalEncrypt, crypto.subtle, args);
  });
  const sealed = await sealShareTarget(key, plain);
  expect(offered).toBe(plain);
  expect(await openShareTarget(key, sealed)).toEqual(new Uint8Array([8, 2]));
});

it("WebCrypto consumes the plaintext at invocation even if the caller mutates afterward", async () => {
  const key = newShareTargetKey();
  const plain = new Uint8Array([1, 2]);
  const original = crypto.subtle.encrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce((...args) => {
    const pending = Reflect.apply(original, crypto.subtle, args);
    plain.fill(9);
    return pending;
  });
  const sealed = await sealShareTarget(key, plain);
  expect(await openShareTarget(key, sealed)).toEqual(new Uint8Array([1, 2]));
});

it("opens an offset ciphertext view without copying its input", async () => {
  const key = newShareTargetKey();
  const sealed = await sealShareTarget(key, new Uint8Array([1, 2]));
  const backing = new Uint8Array(sealed.length + 4).fill(9);
  backing.set(sealed, 2);
  const view = backing.subarray(2, -2);
  const original = crypto.subtle.decrypt.bind(crypto.subtle);
  let offered: BufferSource | undefined;
  vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...args) => {
    offered = args[2];
    return Reflect.apply(original, crypto.subtle, args);
  });
  expect(await openShareTarget(key, view)).toEqual(new Uint8Array([1, 2]));
  if (!(offered instanceof Uint8Array))
    throw new Error("ciphertext view missing");
  expect(offered.buffer).toBe(backing.buffer);
  expect(offered.byteOffset).toBe(view.byteOffset + 12);
  expect(offered.byteLength).toBe(view.byteLength - 12);
});

it("uses the real ciphertext view despite spoofed properties and methods", async () => {
  const key = newShareTargetKey();
  const actual = await sealShareTarget(key, new Uint8Array([1, 2]));
  const other = await sealShareTarget(key, new Uint8Array([9, 9]));
  Object.defineProperties(actual, {
    length: { value: 0 },
    byteLength: { value: 0 },
    byteOffset: { value: 0 },
    buffer: { value: other.buffer },
    subarray: {
      value: (...args: number[]) =>
        Reflect.apply(Uint8Array.prototype.subarray, other, args),
    },
  });
  expect(await openShareTarget(key, actual)).toEqual(new Uint8Array([1, 2]));
});

it("does not consult a ciphertext subclass species", async () => {
  const key = newShareTargetKey();
  const actual = await sealShareTarget(key, new Uint8Array([1, 2]));
  class SpoofedSpecies extends Uint8Array {
    static get [Symbol.species]() {
      throw new Error("unexpected species");
    }
  }
  expect(await openShareTarget(key, new SpoofedSpecies(actual))).toEqual(
    new Uint8Array([1, 2]),
  );
});

it("retains authentication failure when ciphertext changes during import", async () => {
  const key = newShareTargetKey();
  const sealed = await sealShareTarget(key, new Uint8Array([1, 2]));
  const original = crypto.subtle.importKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "importKey").mockImplementationOnce(
    async (...args) => {
      const imported = await Reflect.apply(original, crypto.subtle, args);
      sealed.fill(0);
      return imported;
    },
  );
  await expect(openShareTarget(key, sealed)).rejects.toThrow();
});

it("refuses spoofed shared, detached and out-of-bounds views", async () => {
  const key = newShareTargetKey();
  const shared = new Uint8Array(new SharedArrayBuffer(16));
  Object.defineProperty(shared, "buffer", { value: new ArrayBuffer(16) });
  await expect(sealShareTarget(key, shared)).rejects.toThrow(TypeError);
  await expect(openShareTarget(key, shared)).rejects.toThrow(TypeError);
  const detached = new Uint8Array([1, 2]);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  await expect(sealShareTarget(key, detached)).rejects.toThrow(TypeError);
  const buffer = Reflect.construct(ArrayBuffer, [16, { maxByteLength: 32 }]);
  const outOfBounds = new Uint8Array(buffer, 0, 16);
  Reflect.apply(Reflect.get(buffer, "resize"), buffer, [0]);
  await expect(sealShareTarget(key, outOfBounds)).rejects.toThrow(TypeError);
  await expect(openShareTarget(key, outOfBounds)).rejects.toThrow(
    "invalid share entry",
  );
});

it("checks invalid encoded keys before input data", async () => {
  const shared = new Uint8Array(new SharedArrayBuffer(16));
  await expect(sealShareTarget("invalid", shared)).rejects.toThrow(
    "invalid share key",
  );
  await expect(openShareTarget("invalid", shared)).rejects.toThrow(
    "invalid share entry",
  );
});
