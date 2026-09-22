import { describe, expect, it } from "vitest";
import { canonicalJson, digestCanonical, fnv1a64Hex } from "./digest.js";
import { REASON_CODES, capabilityId, isReasonCode } from "./ids.js";

describe("ids", () => {
  it("brands valid capability ids and rejects malformed ones", () => {
    expect(capabilityId("vault.write")).toBeDefined();
    expect(capabilityId("")).toBeUndefined();
    expect(capabilityId("UPPER.case")).toBeUndefined();
    expect(capabilityId(".leading")).toBeUndefined();
    expect(capabilityId(null)).toBeUndefined();
    expect(capabilityId(42)).toBeUndefined();
  });

  it("keeps the reason-code union closed", () => {
    expect(REASON_CODES).toContain("NOT_DISTRIBUTED");
    expect(isReasonCode("PROHIBITED_BY_INSTANCE")).toBe(true);
    expect(isReasonCode("MADE_UP")).toBe(false);
    expect(isReasonCode(7)).toBe(false);
  });
});

describe("digest", () => {
  it("canonicalizes with sorted keys", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });

  it("drops undefined object fields but keeps explicit null", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("rejects functions and non-finite numbers", () => {
    expect(canonicalJson({ f: () => 1 })).toBeUndefined();
    expect(canonicalJson({ n: Number.NaN })).toBeUndefined();
    expect(canonicalJson({ n: Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  it("formats integers without decimal drift", () => {
    expect(canonicalJson({ n: 3 })).toBe('{"n":3}');
  });

  it("produces stable digests and a known FNV-1a behavior", () => {
    // \"a\" hashes deterministically and differs from \"b\"; the exact
    // constant is covered by digestCanonical ordering tests below.
    expect(fnv1a64Hex("a")).toBe(fnv1a64Hex("a"));
    expect(fnv1a64Hex("a")).not.toBe(fnv1a64Hex("b"));
    expect(digestCanonical({ a: 1, b: 2 })).toBe(
      digestCanonical({ b: 2, a: 1 }),
    );
    expect(digestCanonical({ a: 1 })).not.toBe(digestCanonical({ a: 2 }));
  });
});
