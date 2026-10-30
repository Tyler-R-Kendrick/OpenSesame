/** @vitest-environment node */
import { afterEach, expect, it, vi } from "vitest";
import {
  newShareTargetKey,
  openShareTarget,
  sealShareTarget,
} from "./share-target.js";

afterEach(() => vi.restoreAllMocks());

it("seals an exact snapshot when the caller mutates the plaintext during key import", async () => {
  const key = newShareTargetKey();
  const backing = new Uint8Array([9, 1, 2, 9]);
  const plain = backing.subarray(1, 3);
  const original = crypto.subtle.importKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "importKey").mockImplementationOnce(
    async (...args) => {
      const imported = await Reflect.apply(original, crypto.subtle, args);
      backing[1] = 8;
      return imported;
    },
  );
  const sealed = await sealShareTarget(key, plain);
  expect(await openShareTarget(key, sealed)).toEqual(new Uint8Array([1, 2]));
});

it("opens an exact snapshot when ciphertext changes during key import", async () => {
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
  expect(await openShareTarget(key, sealed)).toEqual(new Uint8Array([1, 2]));
});

it("refuses spoofed shared and detached views", async () => {
  const key = newShareTargetKey();
  const shared = new Uint8Array(new SharedArrayBuffer(16));
  Object.defineProperty(shared, "buffer", { value: new ArrayBuffer(16) });
  await expect(sealShareTarget(key, shared)).rejects.toThrow(TypeError);
  await expect(openShareTarget(key, shared)).rejects.toThrow(
    "invalid share entry",
  );
  const detached = new Uint8Array([1, 2]);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  await expect(sealShareTarget(key, detached)).rejects.toThrow(TypeError);
});
