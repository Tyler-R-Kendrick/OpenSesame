import { runInNewContext } from "node:vm";
import { overlapCast } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import { copyPrfBytes } from "./local-passkey-prf-bytes.js";
import { resizableArrayBuffer } from "./resizable-array-buffer.test-support.js";

it("copies exactly the real view without consulting spoofed metadata, slice or species", () => {
  const buffer = new ArrayBuffer(10);
  const original = new Uint8Array(buffer, 2, 4);
  original.set([1, 2, 3, 4]);
  const unrelated = new Uint8Array(4).fill(9).buffer;
  Object.defineProperty(buffer, "slice", { value: () => unrelated });
  Object.defineProperty(buffer, "constructor", {
    value: {
      get [Symbol.species]() {
        throw new Error("species used");
      },
    },
  });
  Object.defineProperties(original, {
    buffer: { value: unrelated },
    byteLength: { value: 0 },
    byteOffset: { value: 0 },
    values: {
      value: () => {
        throw new Error("caller values used");
      },
    },
    slice: {
      value: () => {
        throw new Error("caller slice used");
      },
    },
    [Symbol.iterator]: {
      value: () => {
        throw new Error("caller iterator used");
      },
    },
  });
  const copied = copyPrfBytes(original);
  expect([...new Uint8Array(copied)]).toEqual([1, 2, 3, 4]);
  new Uint8Array(copied).fill(0);
  expect([...new Uint8Array(buffer, 2, 4)]).toEqual([1, 2, 3, 4]);
  expect([...new Uint8Array(unrelated)]).toEqual([9, 9, 9, 9]);
});

it("copies cross-realm views but rejects shared, detached and invalid brands", () => {
  const foreign: Uint8Array = runInNewContext("new Uint8Array([5, 6, 7])");
  expect([...new Uint8Array(copyPrfBytes(foreign))]).toEqual([5, 6, 7]);
  const shared = new Uint8Array(new SharedArrayBuffer(4)).fill(8);
  expect(() => copyPrfBytes(shared)).toThrow();
  expect(shared.every((byte) => byte === 8)).toBe(true);
  const detached = new Uint8Array(4);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  expect(() => copyPrfBytes(detached)).toThrow();
  expect(() => copyPrfBytes(overlapCast(new Uint16Array([1])))).toThrow();
  const resized = resizableArrayBuffer(8, 16);
  const outOfBounds = new Uint8Array(resized.buffer, 2, 4);
  resized.resize(0);
  expect(() => copyPrfBytes(outOfBounds)).toThrow();
});
