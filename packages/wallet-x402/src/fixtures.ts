import type { ExactPaymentProfile, X402PaymentRequirement } from "./types.js";

/** Local anvil-style fixture ids — never mainnet, never real facilitators. */
export const FIXTURE_CHAIN_ID = "31337";
export const FIXTURE_TOKEN = "0x00000000000000000000000000000000000000a1";
export const FIXTURE_RECIPIENT = "0x00000000000000000000000000000000000000b2";
export const FIXTURE_AMOUNT = "1000000";

export function fixtureProfile(
  overrides: Partial<ExactPaymentProfile> = {},
): ExactPaymentProfile {
  const base: ExactPaymentProfile = {
    id: "x402-exact",
    scheme: "exact",
    protocolVersion: "x402-exact/foundation",
    approved: {
      chainId: FIXTURE_CHAIN_ID,
      tokenContract: FIXTURE_TOKEN,
      recipient: FIXTURE_RECIPIENT,
      amount: FIXTURE_AMOUNT,
      resource: {
        method: "GET",
        origin: "http://127.0.0.1:9",
        path: "/paid",
      },
    },
    authority: {
      kind: "preallocated_purse",
      allocationRef: "alloc_fixture_1",
      accountRef: "acct_fixture_1",
    },
    maxRetries: 2,
    maxBillableAttempts: 3,
    maxChallengeAlternatives: 1,
    allowImplicitRefill: false,
    allowPermit2: false,
  };

  return {
    ...base,
    ...overrides,
    approved: {
      ...base.approved,
      ...(overrides.approved ?? {}),
    },
  };
}

export function fixtureChallenge(
  overrides: Partial<X402PaymentRequirement> = {},
): X402PaymentRequirement {
  return {
    scheme: "exact",
    network: "local-anvil",
    chainId: FIXTURE_CHAIN_ID,
    asset: FIXTURE_TOKEN,
    payTo: FIXTURE_RECIPIENT,
    maxAmountRequired: FIXTURE_AMOUNT,
    ...overrides,
  };
}
