import { describe, expect, it } from "vitest";
import {
  canonicalEquals,
  canonicalJson,
  digestCanonical,
  fnv1a64Hex,
} from "./digest.js";
import { REASON_CODES, capabilityId, isReasonCode } from "./ids.js";

describe("ids", () => {
  it("brands valid capability ids and rejects malformed ones", () => {
    expect(capabilityId("vault.write")).toBeDefined();
    expect(capabilityId("")).toBeUndefined();
    expect(capabilityId("UPPER.case")).toBeUndefined();
    expect(capabilityId(".leading")).toBeUndefined();
    expect(capabilityId(null)).toBeUndefined();
    expect(capabilityId(42)).toBeUndefined();
    // Overlong ids fail closed rather than truncating.
    expect(capabilityId(`a${"x".repeat(200)}`)).toBeUndefined();
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

  it("produces stable digests and matches the FNV-1a 64 vector", () => {
    // FNV-1a 64 of "a" is af63dc4c8601ec8c (well-known vector).
    expect(fnv1a64Hex("a")).toBe("af63dc4c8601ec8c");
    expect(fnv1a64Hex("a")).not.toBe(fnv1a64Hex("b"));
    expect(digestCanonical({ a: 1, b: 2 })).toBe(
      digestCanonical({ b: 2, a: 1 }),
    );
    expect(digestCanonical({ a: 1 })).not.toBe(digestCanonical({ a: 2 }));
  });

  it("canonicalEquals compares structure, not identity", () => {
    expect(canonicalEquals({ a: 1 }, { a: 1 })).toBe(true);
    expect(canonicalEquals({ a: 1 }, { a: 2 })).toBe(false);
    expect(canonicalEquals({ f: () => 1 }, { f: () => 1 })).toBeUndefined();
  });
});
