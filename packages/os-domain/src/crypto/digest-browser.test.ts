import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type BoundaryValue, isJsonObject } from "../json.js";
import { canonicalize, digestManifest, sha256Hex } from "./digest-browser.js";
import { canonicalize as nodeCanonicalize } from "./digest.js";

describe("browser digest interoperability", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ])("matches published SHA-256 vectors for %j", (input, digest) => {
    expect(sha256Hex(input ?? "")).toBe(`sha256:${digest}`);
  });

  it.each([1, 55, 56, 63, 64, 65, 127, 128, 129, 4097])(
    "matches the platform oracle across padding boundaries (%i bytes)",
    (length) => {
      const bytes = Uint8Array.from({ length }, (_, index) => index % 251);
      const expected = createHash("sha256").update(bytes).digest("hex");
      expect(sha256Hex(bytes)).toBe(`sha256:${expected}`);
    },
  );

  it("hashes Unicode as UTF-8 without normalizing distinct strings", () => {
    const value = "fixture 🔐 café";
    expect(sha256Hex(value)).toBe(
      `sha256:${createHash("sha256").update(value).digest("hex")}`,
    );
    expect(sha256Hex("é")).not.toBe(sha256Hex("e\u0301"));
  });

  it("matches Node canonicalization for supported structured values", () => {
    class Amount {
      toJSON() {
        return { currency: "USD", amount: 7 };
      }
    }
    const values: BoundaryValue[] = [
      null,
      true,
      7,
      "fixture",
      new Date("2026-01-02T03:04:05Z"),
      new Map([
        ["z", 2],
        ["a", 1],
      ]),
      new Amount(),
      { z: [3, { b: 2, a: 1 }], a: null },
    ];
    for (const value of values)
      expect(canonicalize(value)).toBe(nodeCanonicalize(value));
    expect(canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it("binds prototype-named JSON members rather than silently omitting them", () => {
    const value: BoundaryValue = JSON.parse(
      '{"b":1,"__proto__":{"x":1},"constructor":{"prototype":{"y":2}},"a":2}',
    );
    if (!isJsonObject(value)) throw new Error("Fixture must be an object");
    expect(canonicalize(value)).toBe(nodeCanonicalize(value));
    expect(digestManifest(value)).not.toBe(
      digestManifest({ b: 1, constructor: { prototype: { y: 2 } }, a: 2 }),
    );
    expect(Object.hasOwn({}, "x")).toBe(false);
  });

  it("binds nested manifest content while ignoring object insertion order", () => {
    const first = { z: [{ b: 2, a: 1 }], a: "fixture" };
    const reordered = { a: "fixture", z: [{ a: 1, b: 2 }] };
    expect(digestManifest(first)).toBe(digestManifest(reordered));
    expect(digestManifest(first)).not.toBe(
      digestManifest({ ...first, a: "changed" }),
    );
    expect(digestManifest(first)).toBe(
      `sha256:${createHash("sha256").update(nodeCanonicalize(first)).digest("hex")}`,
    );
  });
});
