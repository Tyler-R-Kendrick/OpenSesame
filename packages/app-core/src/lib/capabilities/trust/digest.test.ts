import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { sha256Hex } from "./digest.js";

it("hashes only the real offset view, ignoring a spoofed buffer property", async () => {
  const bytes = new Uint8Array([9, 1, 2, 9]).subarray(1, 3);
  Object.defineProperty(bytes, "buffer", {
    value: new Uint8Array([9, 9, 9, 9]).buffer,
  });
  const expected = createHash("sha256")
    .update(new Uint8Array([1, 2]))
    .digest("hex");
  expect(await sha256Hex(bytes)).toBe(expected);
  const foreign = runInNewContext(
    "new Uint8Array([9, 1, 2, 9]).subarray(1, 3)",
  );
  expect(await sha256Hex(foreign)).toBe(expected);
});

it("refuses a shared or detached view rather than hashing substituted or empty bytes", async () => {
  const shared = new Uint8Array(new SharedArrayBuffer(2));
  Object.defineProperty(shared, "buffer", { value: new ArrayBuffer(2) });
  await expect(sha256Hex(shared)).rejects.toThrow(TypeError);
  const detached = new Uint8Array([1, 2]);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  await expect(sha256Hex(detached)).rejects.toThrow(TypeError);
});
