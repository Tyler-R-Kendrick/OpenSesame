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

it("opens only a ciphertext subview with surrounding sentinels", async () => {
  const key = newShareTargetKey();
  const sealed = await sealShareTarget(key, new Uint8Array([1, 2]));
  const backing = new Uint8Array(sealed.length + 4).fill(9);
  backing.set(sealed, 2);
  expect(await openShareTarget(key, backing.subarray(2, -2))).toEqual(
    new Uint8Array([1, 2]),
  );
});

it("refuses non-Uint8 and out-of-bounds views for both operations", async () => {
  const key = newShareTargetKey();
  const wrong = new Uint16Array(16);
  Object.defineProperty(wrong, Symbol.toStringTag, { value: "Uint8Array" });
  await expect(
    Reflect.apply(sealShareTarget, undefined, [key, wrong]),
  ).rejects.toThrow(TypeError);
  await expect(
    Reflect.apply(openShareTarget, undefined, [key, wrong]),
  ).rejects.toThrow("invalid share entry");
  const buffer = Reflect.construct(ArrayBuffer, [16, { maxByteLength: 32 }]);
  const outOfBounds = new Uint8Array(buffer, 0, 16);
  Reflect.apply(Reflect.get(buffer, "resize"), buffer, [0]);
  await expect(sealShareTarget(key, outOfBounds)).rejects.toThrow(TypeError);
  await expect(openShareTarget(key, outOfBounds)).rejects.toThrow(
    "invalid share entry",
  );
});

it("checks an invalid key before invalid bytes", async () => {
  const shared = new Uint8Array(new SharedArrayBuffer(16));
  await expect(sealShareTarget("invalid", shared)).rejects.toThrow(
    "invalid share key",
  );
  await expect(openShareTarget("invalid", shared)).rejects.toThrow(
    "invalid share entry",
  );
});

it.each(["success", "encrypt failure"])(
  "wipes the plaintext snapshot after %s without wiping the caller",
  async (outcome) => {
    const key = newShareTargetKey();
    const plain = new Uint8Array([1, 2]);
    const original = crypto.subtle.encrypt.bind(crypto.subtle);
    let snapshot: BufferSource | undefined;
    vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(
      async (...args) => {
        snapshot = args[2];
        if (outcome === "encrypt failure") throw new Error("encrypt failed");
        return Reflect.apply(original, crypto.subtle, args);
      },
    );
    if (outcome === "success") await sealShareTarget(key, plain);
    else
      await expect(sealShareTarget(key, plain)).rejects.toThrow(
        "encrypt failed",
      );
    if (!(snapshot instanceof Uint8Array)) throw new Error("snapshot missing");
    expect(snapshot).toEqual(new Uint8Array([0, 0]));
    expect(plain).toEqual(new Uint8Array([1, 2]));
  },
);

it("wipes the plaintext snapshot after key import fails", async () => {
  const key = newShareTargetKey();
  const plain = new Uint8Array([1, 2]);
  const fills = vi.spyOn(Uint8Array.prototype, "fill");
  vi.spyOn(crypto.subtle, "importKey").mockRejectedValueOnce(
    new Error("import failed"),
  );
  await expect(sealShareTarget(key, plain)).rejects.toThrow("import failed");
  expect(
    fills.mock.contexts.some(
      (view) =>
        view !== plain &&
        view instanceof Uint8Array &&
        view.length === 2 &&
        [...view].every((byte) => byte === 0),
    ),
  ).toBe(true);
  expect(plain).toEqual(new Uint8Array([1, 2]));
});
