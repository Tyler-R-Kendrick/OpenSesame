import { describe, expect, it } from "vitest";
import { fnv1a32Hex } from "../fnv1a.js";

describe("fnv1a32Hex", () => {
  it("matches the published FNV-1a 32-bit vectors", () => {
    expect(fnv1a32Hex("")).toBe("811c9dc5");
    expect(fnv1a32Hex("a")).toBe("e40c292c");
    expect(fnv1a32Hex("foobar")).toBe("bf9cf968");
  });

  it("hashes UTF-16 code units, as both copies it replaced did", () => {
    // Not the UTF-8 byte vectors: these pin that ids and cache names made
    // before the consolidation still hash the same.
    expect(fnv1a32Hex("é")).toBe("6c0b6c44");
    expect(fnv1a32Hex("日本")).toBe("5ffcbea4");
    expect(fnv1a32Hex("\u{1F510}")).toBe("db2d24e8");
  });
});
