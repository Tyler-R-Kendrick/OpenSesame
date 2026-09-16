import { describe, expect, it } from "vitest";

import { matchChallenge } from "./challenge.js";
import {
  FIXTURE_AMOUNT,
  FIXTURE_CHAIN_ID,
  FIXTURE_RECIPIENT,
  FIXTURE_TOKEN,
  fixtureChallenge,
  fixtureProfile,
} from "./fixtures.js";

describe("matchChallenge", () => {
  it("accepts an exact match on chain, token, recipient, and amount", () => {
    const profile = fixtureProfile();
    const result = matchChallenge(profile.approved, fixtureChallenge());
    expect(result).toEqual({ ok: true });
  });

  it("rejects wrong chainId (WAL-E11)", () => {
    const profile = fixtureProfile();
    const result = matchChallenge(
      profile.approved,
      fixtureChallenge({ chainId: "1" }),
    );
    expect(result).toEqual({
      ok: false,
      code: "CHALLENGE_CHAIN_MISMATCH",
      expected: FIXTURE_CHAIN_ID,
      actual: "1",
    });
  });

  it("rejects wrong token contract (WAL-E11)", () => {
    const profile = fixtureProfile();
    const wrong = "0x00000000000000000000000000000000000000ff";
    const result = matchChallenge(
      profile.approved,
      fixtureChallenge({ asset: wrong }),
    );
    expect(result).toEqual({
      ok: false,
      code: "CHALLENGE_TOKEN_MISMATCH",
      expected: FIXTURE_TOKEN,
      actual: wrong,
    });
  });

  it("rejects wrong recipient (WAL-E11)", () => {
    const profile = fixtureProfile();
    const wrong = "0x00000000000000000000000000000000000000cc";
    const result = matchChallenge(
      profile.approved,
      fixtureChallenge({ payTo: wrong }),
    );
    expect(result).toEqual({
      ok: false,
      code: "CHALLENGE_RECIPIENT_MISMATCH",
      expected: FIXTURE_RECIPIENT,
      actual: wrong,
    });
  });

  it("rejects amount drift", () => {
    const profile = fixtureProfile();
    const result = matchChallenge(
      profile.approved,
      fixtureChallenge({ maxAmountRequired: "999" }),
    );
    expect(result).toEqual({
      ok: false,
      code: "CHALLENGE_AMOUNT_MISMATCH",
      expected: FIXTURE_AMOUNT,
      actual: "999",
    });
  });

  it("rejects non-exact schemes at the matcher", () => {
    const profile = fixtureProfile();
    const result = matchChallenge(
      profile.approved,
      fixtureChallenge({ scheme: "upto" }),
    );
    expect(result).toEqual({
      ok: false,
      code: "CHALLENGE_SCHEME_MISMATCH",
      expected: "exact",
      actual: "upto",
    });
  });
});
