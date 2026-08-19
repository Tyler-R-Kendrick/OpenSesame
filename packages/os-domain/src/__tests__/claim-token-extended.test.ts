import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CROCKFORD_ALPHABET,
  constantTimeEqual,
  digestClaimToken,
  digestDeviceCode,
  digestUserCode,
  generateClaimToken,
  generateUserCode,
  hmacDigest,
  parseClaimToken,
  verifyClaimToken,
} from "../index.js";
import { fixtures } from "./fixtures.js";

describe("hmacDigest", () => {
  it("accepts a byte-array pepper equivalent to its string form", () => {
    const fromString = hmacDigest(fixtures.pepper, "p", "id", "secret");
    const fromBytes = hmacDigest(
      new TextEncoder().encode(fixtures.pepper),
      "p",
      "id",
      "secret",
    );
    expect(constantTimeEqual(fromString, fromBytes)).toBe(true);
  });

  it("length-prefixes fields so boundaries cannot be shifted", () => {
    // Without length prefixes ("ab"||"c") and ("a"||"bc") would collide.
    const a = hmacDigest(fixtures.pepper, "ab", "c", "s");
    const b = hmacDigest(fixtures.pepper, "a", "bc", "s");
    expect(constantTimeEqual(a, b)).toBe(false);
  });
});

describe("constantTimeEqual", () => {
  it("returns false for different-length inputs", () => {
    expect(
      constantTimeEqual(new Uint8Array(32).fill(1), new Uint8Array(16).fill(1)),
    ).toBe(false);
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  it("returns false for same-length inputs that differ", () => {
    const a = new Uint8Array(32).fill(1);
    const b = new Uint8Array(32).fill(1);
    b[31] = 2;
    expect(constantTimeEqual(a, b)).toBe(false);
    expect(constantTimeEqual(a, a)).toBe(true);
  });
});

describe("generateClaimToken defaults", () => {
  it("generates a random base64url public id when none is given", () => {
    const t = generateClaimToken(fixtures.pepper);
    expect(t.publicId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(t.secret.length).toBeGreaterThan(0);
    expect(t.token).toBe(`osc_clm_${t.publicId}.${t.secret}`);
    expect(parseClaimToken(t.token)).toEqual({
      publicId: t.publicId,
      secret: t.secret,
    });
  });

  it("accepts an explicit secret byte buffer", () => {
    const t = generateClaimToken(fixtures.pepper, "pid", randomBytes(16));
    expect(t.token).toMatch(/^osc_clm_pid\.[A-Za-z0-9_-]{22}$/);
  });
});

describe("parseClaimToken edge cases", () => {
  it("rejects a dot at the very start of the id portion", () => {
    expect(parseClaimToken("osc_clm_.secret")).toBeNull();
  });

  it("rejects a secret that is only padding", () => {
    expect(parseClaimToken("osc_clm_id.")).toBeNull();
  });

  it("keeps additional dots inside the secret", () => {
    const parsed = parseClaimToken("osc_clm_id.se.cret");
    expect(parsed).toEqual({ publicId: "id", secret: "se.cret" });
  });
});

describe("verifyClaimToken", () => {
  it("returns false for malformed tokens instead of throwing", () => {
    const t = generateClaimToken(fixtures.pepper);
    expect(verifyClaimToken(fixtures.pepper, "not-a-token", t.digest)).toBe(
      false,
    );
    expect(verifyClaimToken(fixtures.pepper, "osc_clm_onlyid", t.digest)).toBe(
      false,
    );
  });

  it("digests a well-formed token deterministically", () => {
    const t = generateClaimToken(fixtures.pepper, "pid");
    expect(digestClaimToken(fixtures.pepper, t.token)).toEqual(t.digest);
  });
});

describe("generateUserCode", () => {
  it("formats 5-byte codes as XXXX-XXXX", () => {
    const code = generateUserCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it("returns an unhyphenated body for shorter byte counts", () => {
    const code = generateUserCode(4);
    // ceil(4*8/5) = 7 chars, below the 8-char hyphenation threshold
    expect(code).toHaveLength(7);
    expect(code.includes("-")).toBe(false);
    for (const c of code) {
      expect(CROCKFORD_ALPHABET.includes(c)).toBe(true);
    }
  });

  it("truncates longer byte counts to the same XXXX-XXXX shape", () => {
    // ceil(8*8/5) = 13 raw chars, but formatting keeps only the first 8
    const code = generateUserCode(8);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });
});

describe("digestDeviceCode", () => {
  it("binds the digest to its session", () => {
    const code = "DEVICE-CODE";
    const forOne = digestDeviceCode(fixtures.pepper, "das_1", code);
    const forTwo = digestDeviceCode(fixtures.pepper, "das_2", code);
    expect(constantTimeEqual(forOne, forTwo)).toBe(false);
    expect(forOne.length).toBe(32);
  });

  it("differs from a user-code digest of the same code and session", () => {
    const asDevice = digestDeviceCode(fixtures.pepper, "das_1", "ABCD");
    const asUser = digestUserCode(fixtures.pepper, "das_1", "ABCD");
    expect(constantTimeEqual(asDevice, asUser)).toBe(false);
  });

  it("requires a session id", () => {
    expect(() => digestDeviceCode(fixtures.pepper, "", "ABCD")).toThrow(
      /requires the session id/,
    );
  });
});
