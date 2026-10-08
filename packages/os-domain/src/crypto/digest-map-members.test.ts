import { describe, expect, it } from "vitest";
import type { BoundaryValue } from "../json.js";
import { canonicalize as browserCanonicalize } from "./digest-browser.js";
import { canonicalize as nodeCanonicalize } from "./digest.js";

describe.each([
  { name: "Node", canonicalize: nodeCanonicalize },
  { name: "browser", canonicalize: browserCanonicalize },
])("$name Map canonicalization", ({ canonicalize }) => {
  it("preserves prototype-named own members without changing the input", () => {
    const map = new Map<PropertyKey, BoundaryValue>([
      ["constructor", { prototype: { tag: "public" } }],
      ["__proto__", { sentinel: 7 }],
    ]);
    expect(canonicalize(map)).toBe(
      '{"__proto__":{"sentinel":7},"constructor":{"prototype":{"tag":"public"}}}',
    );
    expect(canonicalize(map)).not.toBe(
      canonicalize(
        new Map([["constructor", { prototype: { tag: "public" } }]]),
      ),
    );
    expect(map.size).toBe(2);
    expect(map.get("__proto__")).toEqual({ sentinel: 7 });
  });

  it("retains prototype-named members in nested Maps", () => {
    const map = new Map([["__proto__", { z: 2, a: 1 }]]);
    expect(canonicalize({ nested: map })).toBe(
      '{"nested":{"__proto__":{"a":1,"z":2}}}',
    );
  });

  it("preserves existing numeric-key and insertion-order compatibility", () => {
    const first = new Map<PropertyKey, BoundaryValue>([
      ["b", 2],
      [10, "ten"],
      ["a", 1],
    ]);
    const second = new Map<PropertyKey, BoundaryValue>([
      ["a", 1],
      [10, "ten"],
      ["b", 2],
    ]);
    expect(canonicalize(first)).toBe('{"10":"ten","a":1,"b":2}');
    expect(canonicalize(second)).toBe(canonicalize(first));
  });

  it.each([
    {
      name: "number and string",
      map: new Map<PropertyKey, BoundaryValue>([
        [1, 7],
        ["1", 8],
      ]),
    },
    {
      name: "distinct symbols",
      map: new Map<PropertyKey, BoundaryValue>([
        [Symbol("fixture"), 7],
        [Symbol("fixture"), 8],
      ]),
    },
  ])("rejects ambiguous converted keys: $name", ({ map }) => {
    expect(() => canonicalize(map)).toThrow("Ambiguous Map key.");
    expect(map.size).toBe(2);
  });
});
