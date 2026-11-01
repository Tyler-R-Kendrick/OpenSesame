import { describe, expect, it } from "vitest";
import {
  asBufferSource,
  bytesFromBufferSource,
  ownBytes,
} from "./buffer-source.js";

describe("buffer-source", () => {
  it("copies into ArrayBuffer-backed views", () => {
    const input = Uint8Array.of(1, 2, 3);
    const owned = ownBytes(input);
    expect(owned.buffer).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(owned)).toEqual([1, 2, 3]);
    expect(owned.buffer).not.toBe(input.buffer);
  });

  it("round-trips BufferSource normalization", () => {
    const original = Uint8Array.of(9, 8);
    const normalized = bytesFromBufferSource(asBufferSource(original));
    expect(Array.from(normalized)).toEqual([9, 8]);
  });
});
