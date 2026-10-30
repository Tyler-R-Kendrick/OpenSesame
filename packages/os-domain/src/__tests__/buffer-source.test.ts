import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { isArrayBufferBackedBytes } from "../buffer-source.js";

describe("isArrayBufferBackedBytes", () => {
  it("accepts ordinary, offset, and cross-realm byte views", () => {
    expect(isArrayBufferBackedBytes(new Uint8Array([1, 2]).subarray(1))).toBe(
      true,
    );
    const foreign = runInNewContext("new Uint8Array([1, 2])");
    expect(isArrayBufferBackedBytes(foreign)).toBe(true);
  });
  it("refuses shared backing stores even when their buffer property is spoofed", () => {
    const shared = new Uint8Array(new SharedArrayBuffer(2));
    expect(isArrayBufferBackedBytes(shared)).toBe(false);
    Object.defineProperty(shared, "buffer", { value: new ArrayBuffer(2) });
    expect(isArrayBufferBackedBytes(shared)).toBe(false);
  });
  it("does not mistake a detached ArrayBuffer for a shared buffer", () => {
    const detached = new Uint8Array(2);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    expect(isArrayBufferBackedBytes(detached)).toBe(true);
  });
  it("uses the real backing store when an ordinary view spoofs buffer", () => {
    const normal = new Uint8Array([1, 2]);
    Object.defineProperty(normal, "buffer", {
      value: new SharedArrayBuffer(2),
    });
    expect(isArrayBufferBackedBytes(normal)).toBe(true);
  });
});
