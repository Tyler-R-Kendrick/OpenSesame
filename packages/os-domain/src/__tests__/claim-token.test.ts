import { describe, expect, it } from "vitest";
import {
  CROCKFORD_ALPHABET,
  constantTimeEqual,
  digestClaimToken,
  digestUserCode,
  generateClaimToken,
  generateUserCode,
  normalizeUserCode,
  parseClaimToken,
  verifyClaimToken,
  verifyUserCode,
} from "../index.js";
import { fixtures } from "./fixtures.js";

describe("claim token digest", () => {
  it("generates osc_clm_<id>.<secret> form", () => {
    const t = generateClaimToken(fixtures.pepper, "abc123");
    expect(t.token).toMatch(/^osc_clm_abc123\.[A-Za-z0-9_-]+$/);
    expect(t.publicId).toBe("abc123");
    expect(t.digest).toBeInstanceOf(Uint8Array);
    expect(t.digest.length).toBe(32);
  });

  it("verifies with constant-time compare", () => {
    const t = generateClaimToken(fixtures.pepper);
    expect(verifyClaimToken(fixtures.pepper, t.token, t.digest)).toBe(true);
    expect(verifyClaimToken(fixtures.pepper, `${t.token}x`, t.digest)).toBe(
      false,
    );
    expect(verifyClaimToken("other-pepper", t.token, t.digest)).toBe(false);
  });

  it("purpose prefix changes digest", () => {
    const t = generateClaimToken(fixtures.pepper, "pid");
    const again = digestClaimToken(fixtures.pepper, t.token);
    if (!again) throw new Error("generated claim token did not digest");
    expect(constantTimeEqual(again, t.digest)).toBe(true);
    const parsed = parseClaimToken(t.token);
    if (!parsed) throw new Error("generated claim token did not parse");
    expect(parsed.publicId).toBe("pid");
  });

  it("rejects malformed tokens", () => {
    expect(parseClaimToken("not-a-token")).toBeNull();
    expect(parseClaimToken("osc_clm_onlyid")).toBeNull();
    expect(digestClaimToken(fixtures.pepper, "osc_clm_.")).toBeNull();
  });
});

describe("user codes", () => {
  it("uses Crockford alphabet and hashes with purpose", () => {
    const code = generateUserCode();
    const body = code.replace(/-/g, "");
    expect(body.split("").every((c) => CROCKFORD_ALPHABET.includes(c))).toBe(
      true,
    );
    const digest = digestUserCode(fixtures.pepper, "clm_1", code);
    expect(verifyUserCode(fixtures.pepper, "clm_1", code, digest)).toBe(true);
    expect(
      verifyUserCode(
        fixtures.pepper,
        "clm_1",
        normalizeUserCode(code.toLowerCase()),
        digest,
      ),
    ).toBe(true);
    expect(verifyUserCode(fixtures.pepper, "clm_1", "XXXX-XXXX", digest)).toBe(
      false,
    );
  });

  it("binds the digest to one claim", () => {
    const code = generateUserCode();
    const forOne = digestUserCode(fixtures.pepper, "clm_1", code);
    const forAnother = digestUserCode(fixtures.pepper, "clm_2", code);
    // A ~40-bit code with a shared label meant one precomputation covered every
    // claim ever issued; per-claim binding makes each its own search.
    expect(constantTimeEqual(forOne, forAnother)).toBe(false);
    expect(verifyUserCode(fixtures.pepper, "clm_2", code, forOne)).toBe(false);
    expect(() => digestUserCode(fixtures.pepper, "", code)).toThrow(
      /requires the claim id/,
    );
  });
});
