import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalize,
  digestManifest,
  sha256Hex,
  type BoundaryValue,
} from "../index.js";

describe("canonicalize", () => {
  it("sorts object keys recursively", () => {
    const a = canonicalize({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalize({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves array order while canonicalizing elements", () => {
    expect(canonicalize([{ b: 1, a: 2 }, 3])).toBe('[{"a":2,"b":1},3]');
    expect(canonicalize([2, 1])).not.toBe(canonicalize([1, 2]));
  });

  it("serializes Date values as ISO strings", () => {
    const when = new Date("2026-08-07T06:00:00.000Z");
    expect(canonicalize({ when })).toBe('{"when":"2026-08-07T06:00:00.000Z"}');
  });

  it("serializes Maps with keys sorted by string form", () => {
    const map = new Map<PropertyKey, BoundaryValue>([
      [10, "ten"],
      ["b", { z: 1, y: 2 }],
      ["a", null],
    ]);
    expect(canonicalize(map)).toBe('{"10":"ten","a":null,"b":{"y":2,"z":1}}');
  });

  it("honors toJSON on class instances", () => {
    class Money {
      constructor(
        private readonly cents: number,
        private readonly currency: string,
      ) {}
      toJSON() {
        return { currency: this.currency, cents: this.cents };
      }
    }
    expect(canonicalize({ price: new Money(500, "USD") })).toBe(
      '{"price":{"cents":500,"currency":"USD"}}',
    );
  });

  it("passes primitives and null through unchanged", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize("s")).toBe('"s"');
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize(true)).toBe("true");
  });
});

describe("sha256Hex", () => {
  const expected = `sha256:${createHash("sha256").update("hello", "utf8").digest("hex")}`;

  it("hashes string input as utf8", () => {
    expect(sha256Hex("hello")).toBe(expected);
  });

  it("hashes byte input identically to its utf8 string form", () => {
    expect(sha256Hex(new TextEncoder().encode("hello"))).toBe(expected);
  });
});

describe("digestManifest", () => {
  it("is stable across key orderings", () => {
    const m1 = { name: "demo", targets: [{ type: "project", id: "prj_1" }] };
    const m2 = { targets: [{ id: "prj_1", type: "project" }], name: "demo" };
    expect(digestManifest(m1)).toBe(digestManifest(m2));
    expect(digestManifest(m1)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes when the manifest content changes", () => {
    expect(digestManifest({ a: 1 })).not.toBe(digestManifest({ a: 2 }));
  });
});
