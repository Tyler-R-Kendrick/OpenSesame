import { describe, expect, it } from "vitest";
import { fnv1a32Hex } from "../fnv1a.js";

describe("fnv1a32Hex", () => {
  it("matches the published FNV-1a 32-bit vectors", () => {
    expect(fnv1a32Hex("")).toBe("811c9dc5");
    expect(fnv1a32Hex("a")).toBe("e40c292c");
    expect(fnv1a32Hex("foobar")).toBe("bf9cf968");
  });
});
