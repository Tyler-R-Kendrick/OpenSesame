import { describe, expect, it } from "vitest";

import { assessExactPayment } from "./assess.js";
import { fixtureChallenge, fixtureProfile } from "./fixtures.js";
import { PREALLOCATED_PURSE_RESIDUAL_RISK } from "./types.js";

describe("assessExactPayment", () => {
  it("accepts a matching exact challenge under purse authority with residual risk named", () => {
    const assessment = assessExactPayment({
      profile: fixtureProfile(),
      challenge: fixtureChallenge(),
    });

    expect(assessment.accepted).toBe(true);
    expect(assessment.productionEnabled).toBe(false);
    expect(assessment.evidenceStatus).toBe("blocked");
    expect(assessment.refusals).toEqual([]);
    expect(assessment.assumptions).toContain(PREALLOCATED_PURSE_RESIDUAL_RISK);
    expect(assessment.residualRisks).toContain(
      PREALLOCATED_PURSE_RESIDUAL_RISK,
    );
    expect(
      assessment.constraints.every((c) => c.result === "approval_only"),
    ).toBe(true);
  });

  it("refuses upto scheme (X402-07)", () => {
    const assessment = assessExactPayment({
      profile: fixtureProfile(),
      challenge: fixtureChallenge({ scheme: "upto" }),
    });

    expect(assessment.accepted).toBe(false);
    expect(assessment.refusals).toContain("SCHEME_UPTO_REFUSED");
  });

  it("refuses Permit2 extras (X402-07)", () => {
    const assessment = assessExactPayment({
      profile: fixtureProfile(),
      challenge: fixtureChallenge({
        extra: { permit2: true },
      }),
    });

    expect(assessment.accepted).toBe(false);
    expect(assessment.refusals).toContain("PERMIT2_REFUSED");
  });

  it("refuses allowance path extras", () => {
    const assessment = assessExactPayment({
      profile: fixtureProfile(),
      challenge: fixtureChallenge({
        extra: { allowance: true },
      }),
    });

    expect(assessment.accepted).toBe(false);
    expect(assessment.refusals).toContain("ALLOWANCE_PATH_REFUSED");
  });

  it("refuses implicit refill extras (X402-07)", () => {
    const assessment = assessExactPayment({
      profile: fixtureProfile(),
      challenge: fixtureChallenge({
        extra: { refill: true },
      }),
    });

    expect(assessment.accepted).toBe(false);
    expect(assessment.refusals).toContain("IMPLICIT_REFILL_REFUSED");
  });

  it("refuses unbounded challenge alternatives", () => {
    const assessment = assessExactPayment({
      profile: fixtureProfile({ maxChallengeAlternatives: 1 }),
      challenge: fixtureChallenge(),
      alternatives: [fixtureChallenge({ payTo: "0x01" })],
    });

    expect(assessment.accepted).toBe(false);
    expect(assessment.refusals).toContain("UNBOUNDED_CHALLENGE_ALTERNATIVES");
  });

  it("surfaces challenge chain mismatch as a refusal", () => {
    const assessment = assessExactPayment({
      profile: fixtureProfile(),
      challenge: fixtureChallenge({ chainId: "8453" }),
    });

    expect(assessment.accepted).toBe(false);
    expect(assessment.refusals).toContain("CHALLENGE_CHAIN_MISMATCH");
  });
});
