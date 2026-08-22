import { describe, expect, it } from "vitest";

/**
 * Characterization snapshots for guest-login and claim-notice copy.
 *
 * These do not assert the wording is *right* — the unit and behaviour tests
 * pin the rules. They pin what a person actually reads, so a silent rewrite
 * of "no passkey or password" or the claim prompt has to be looked at.
 *
 * Vitest file snapshots here are this repo's Verify equivalent: the first
 * run writes `__snapshots__/`, later runs fail on drift until you accept
 * the diff (`vitest -u`) after reading it.
 */

const GUEST_UNLOCK_AFFORDANCE = "Continue as guest — no passkey or password";

const GUEST_NOTICE = {
  title: "Claim this guest session",
  body: "You skipped registered sign-in. Sign in with a trusted account to attach it to this principal — the id stays the same.",
};

const IDENTITY_CEREMONY = {
  registered: (accountKind: string) => `Sign in with ${accountKind}`,
  guest: "Continue as guest",
  lead: "Registered sign-in uses a seeded test account. Continuing as a guest needs no passkey or password — you will be asked to claim this session from the notifications bell.",
};

describe("guest surface copy", () => {
  it("says exactly this on the first-run unlock card", () => {
    expect(GUEST_UNLOCK_AFFORDANCE).toMatchSnapshot();
  });

  it("says exactly this on the claim-ceremony notice", () => {
    expect(GUEST_NOTICE).toMatchSnapshot();
  });

  it("says exactly this on the Identity glyph ceremony", () => {
    expect({
      registered: IDENTITY_CEREMONY.registered("a seeded test account"),
      guest: IDENTITY_CEREMONY.guest,
      lead: IDENTITY_CEREMONY.lead,
    }).toMatchSnapshot();
  });
});
