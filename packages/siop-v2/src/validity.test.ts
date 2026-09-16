import type { JsonObject } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { isSiopV2Error } from "./errors.js";
import { MAX_EPOCH_SECONDS, MIN_EPOCH_SECONDS } from "./limits.js";
import {
  assertIAmSiopClaim,
  assertTokenFreshness,
  readEpoch,
} from "./validity.js";

function expectCode(run: () => void, code: string, checkpoint: string): void {
  try {
    run();
    expect.unreachable(`expected ${code}`);
  } catch (err) {
    expect(err instanceof Error && isSiopV2Error(err)).toBe(true);
    if (err instanceof Error && isSiopV2Error(err)) {
      expect(err.code).toBe(code);
      expect(err.checkpoint).toBe(checkpoint);
    }
  }
}

describe("readEpoch", () => {
  it("returns integer exp and iat inside the epoch window", () => {
    const payload: JsonObject = { exp: 1_700_000_000, iat: 1_699_999_400 };
    expect(readEpoch(payload, "exp")).toBe(1_700_000_000);
    expect(readEpoch(payload, "iat")).toBe(1_699_999_400);
  });

  it("accepts the inclusive epoch bounds", () => {
    expect(readEpoch({ exp: MIN_EPOCH_SECONDS }, "exp")).toBe(
      MIN_EPOCH_SECONDS,
    );
    expect(readEpoch({ iat: MAX_EPOCH_SECONDS }, "iat")).toBe(
      MAX_EPOCH_SECONDS,
    );
  });

  it("refuses missing, non-number, and non-integer claims", () => {
    expectCode(() => readEpoch({}, "exp"), "malformed_id_token", "validity");
    expectCode(
      () => readEpoch({ exp: "1700000000" }, "exp"),
      "malformed_id_token",
      "validity",
    );
    expectCode(
      () => readEpoch({ exp: 1.5 }, "exp"),
      "malformed_id_token",
      "validity",
    );
    expectCode(
      () => readEpoch({ iat: true }, "iat"),
      "malformed_id_token",
      "validity",
    );
  });

  it("refuses values outside the epoch window", () => {
    expectCode(
      () => readEpoch({ exp: MIN_EPOCH_SECONDS - 1 }, "exp"),
      "malformed_id_token",
      "validity",
    );
    expectCode(
      () => readEpoch({ iat: MAX_EPOCH_SECONDS + 1 }, "iat"),
      "malformed_id_token",
      "validity",
    );
  });
});

describe("assertIAmSiopClaim", () => {
  it("requires true when the profile expects i_am_siop", () => {
    expect(() => assertIAmSiopClaim(true, true)).not.toThrow();
    expectCode(
      () => assertIAmSiopClaim(true, undefined),
      "issuer_mismatch",
      "issuer_profile",
    );
    expectCode(
      () => assertIAmSiopClaim(true, false),
      "issuer_mismatch",
      "issuer_profile",
    );
    expectCode(
      () => assertIAmSiopClaim(true, "true"),
      "issuer_mismatch",
      "issuer_profile",
    );
    expectCode(
      () => assertIAmSiopClaim(true, 1),
      "issuer_mismatch",
      "issuer_profile",
    );
  });

  it("allows absent or explicit false on static profiles", () => {
    expect(() => assertIAmSiopClaim(false, undefined)).not.toThrow();
    expect(() => assertIAmSiopClaim(false, false)).not.toThrow();
  });

  it("refuses truthy i_am_siop on static profiles", () => {
    expectCode(
      () => assertIAmSiopClaim(false, true),
      "issuer_mismatch",
      "issuer_profile",
    );
    expectCode(
      () => assertIAmSiopClaim(false, 1),
      "issuer_mismatch",
      "issuer_profile",
    );
    expectCode(
      () => assertIAmSiopClaim(false, "yes"),
      "issuer_mismatch",
      "issuer_profile",
    );
  });
});

describe("assertTokenFreshness", () => {
  const base = {
    exp: 1_700_000_600,
    iat: 1_700_000_000,
    now: 1_700_000_100,
    skew: 60,
    maxIatAge: 600,
  };

  it("accepts a fresh unexpired token", () => {
    expect(() => assertTokenFreshness(base)).not.toThrow();
  });

  it("refuses expired tokens beyond skew", () => {
    expectCode(
      () =>
        assertTokenFreshness({
          ...base,
          exp: 1_700_000_000,
          now: 1_700_000_100,
          skew: 60,
        }),
      "token_expired",
      "validity",
    );
  });

  it("allows expiry within skew, including the exact now-skew boundary", () => {
    expect(() =>
      assertTokenFreshness({
        ...base,
        exp: 1_700_000_050,
        now: 1_700_000_100,
        skew: 60,
      }),
    ).not.toThrow();
    // exp === now - skew must still pass (strict <, not <=).
    expect(() =>
      assertTokenFreshness({
        ...base,
        exp: 1_700_000_040,
        now: 1_700_000_100,
        skew: 60,
      }),
    ).not.toThrow();
  });

  it("refuses future iat beyond skew", () => {
    expectCode(
      () =>
        assertTokenFreshness({
          ...base,
          iat: 1_700_000_200,
          now: 1_700_000_100,
          skew: 60,
        }),
      "token_not_fresh",
      "validity",
    );
  });

  it("allows iat exactly at now+skew (strict >, not >=)", () => {
    expect(() =>
      assertTokenFreshness({
        ...base,
        iat: 1_700_000_160,
        now: 1_700_000_100,
        skew: 60,
      }),
    ).not.toThrow();
  });

  it("refuses iat older than maxIatAge plus skew", () => {
    expectCode(
      () =>
        assertTokenFreshness({
          ...base,
          iat: 1_699_999_000,
          now: 1_700_000_100,
          skew: 60,
          maxIatAge: 600,
        }),
      "token_not_fresh",
      "validity",
    );
  });

  it("accepts iat at the inclusive maxIatAge boundary", () => {
    // now - skew - maxIatAge = 1_700_000_100 - 60 - 600 = 1_699_999_440
    expect(() =>
      assertTokenFreshness({
        ...base,
        iat: 1_699_999_440,
        now: 1_700_000_100,
        skew: 60,
        maxIatAge: 600,
      }),
    ).not.toThrow();
  });
});
