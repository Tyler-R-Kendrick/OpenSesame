import { describe, expect, it } from "vitest";
import { FuzzedDataProvider } from "./provider.js";

describe("FuzzedDataProvider", () => {
  it("consumeBoolean is true for odd bytes and false for even bytes", () => {
    const p = new FuzzedDataProvider(Buffer.from([1, 2, 255]));
    expect(p.consumeBoolean()).toBe(true);
    expect(p.consumeBoolean()).toBe(false);
    expect(p.consumeBoolean()).toBe(true);
  });

  it("consumeBoolean returns false once the buffer is exhausted", () => {
    const p = new FuzzedDataProvider(Buffer.alloc(0));
    expect(p.consumeBoolean()).toBe(false);
    expect(p.consumeBoolean()).toBe(false);
  });

  it("consumeIntegralInRange reads a big-endian uint32 modulo the span", () => {
    // 0x0000000A = 10; range [0, 4] has span 5 → 10 % 5 = 0
    const p = new FuzzedDataProvider(Buffer.from([0, 0, 0, 10]));
    expect(p.consumeIntegralInRange(0, 4)).toBe(0);
    // 0x0000000B = 11; 11 % 5 = 1 → min 3 + 1 = 4
    const q = new FuzzedDataProvider(Buffer.from([0, 0, 0, 11]));
    expect(q.consumeIntegralInRange(3, 7)).toBe(4);
  });

  it("consumeIntegralInRange returns min when min equals max", () => {
    const p = new FuzzedDataProvider(Buffer.from([9, 9, 9, 9]));
    expect(p.consumeIntegralInRange(5, 5)).toBe(5);
  });

  it("consumeIntegralInRange rejects an inverted range", () => {
    const p = new FuzzedDataProvider(Buffer.from([0, 0, 0, 0]));
    expect(() => p.consumeIntegralInRange(4, 3)).toThrow(RangeError);
  });

  it("consumeIntegralInRange consumes zero-padding past the end of data", () => {
    const p = new FuzzedDataProvider(Buffer.from([1]));
    // one real byte then three implicit zero bytes → 0x01000000
    expect(p.consumeIntegralInRange(0, 255)).toBe((0x01000000 % 256) >>> 0);
  });

  it("consumeString consumes up to maxLength bytes as utf8", () => {
    const p = new FuzzedDataProvider(Buffer.from("hello world", "utf8"));
    expect(p.consumeString(5)).toBe("hello");
    expect(p.consumeString(64)).toBe(" world");
    expect(p.consumeString(8)).toBe("");
  });

  it("consumeString clamps negative lengths to zero", () => {
    const p = new FuzzedDataProvider(Buffer.from("abc", "utf8"));
    expect(p.consumeString(-10)).toBe("");
    expect(p.consumeString(2)).toBe("ab");
  });

  it("consumeString decodes multi-byte utf8 sequences", () => {
    const p = new FuzzedDataProvider(Buffer.from("héllo", "utf8"));
    expect(p.consumeString(10)).toBe("héllo");
  });

  it("consumeRemainingAsString drains whatever is left", () => {
    const p = new FuzzedDataProvider(Buffer.from("abcdef", "utf8"));
    p.consumeString(2);
    expect(p.consumeRemainingAsString()).toBe("cdef");
    expect(p.consumeRemainingAsString()).toBe("");
  });
});
