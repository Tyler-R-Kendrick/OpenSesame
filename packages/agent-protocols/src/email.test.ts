import { describe, expect, it } from "vitest";
import { isEmailLoginHint } from "./email.js";

describe("bounded login hints", () => {
  it("accepts normalized addresses and rejects malformed hints", () => {
    expect(isEmailLoginHint(" Alice+tag@Example.COM ")).toBe(true);
    expect(isEmailLoginHint("a@b")).toBe(false);
    expect(isEmailLoginHint("a@@b.c")).toBe(false);
  });
  it("rejects oversized ambiguous domains before regex validation", () => {
    expect(isEmailLoginHint(`a@${".".repeat(200_000)}@`)).toBe(false);
    expect(isEmailLoginHint(`${"a".repeat(310)}@b.example`)).toBe(true);
    expect(isEmailLoginHint(`${"a".repeat(311)}@b.example`)).toBe(false);
  });
});
