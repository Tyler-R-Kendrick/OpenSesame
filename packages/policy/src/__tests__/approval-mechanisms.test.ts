import type { ApprovalMechanism, AssuranceLevel } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  IncoherentAssuranceError,
  assertAssuranceCoherent,
  isPhishingResistantMechanism,
  mechanismSatisfies,
} from "../approval-mechanisms.js";

/**
 * Swarm D — T-39, finding F13 (ADR 0086, ADR 0084).
 *
 * F13: phishing resistance is a property of *how* a human was asked, not a
 * label a record may carry freely. A re-authenticated session (including a
 * TOTP step) and an out-of-band code are both phishable — a relaying attacker
 * can harvest and replay either — so neither may back `phishing_resistant`
 * assurance or satisfy a policy that demands phishing resistance, whatever the
 * principal record says. These tests pin that mapping so a later change cannot
 * quietly let `session_reauth` clear a bar it does not meet.
 */

const PHISHING_RESISTANT: readonly ApprovalMechanism[] = [
  "webauthn",
  "openid4vp",
];
const PHISHABLE: readonly ApprovalMechanism[] = [
  "session_reauth",
  "out_of_band",
];

describe("isPhishingResistantMechanism", () => {
  for (const mechanism of PHISHING_RESISTANT) {
    it(`treats ${mechanism} as phishing-resistant`, () => {
      expect(isPhishingResistantMechanism(mechanism)).toBe(true);
    });
  }
  for (const mechanism of PHISHABLE) {
    it(`treats ${mechanism} as phishable`, () => {
      expect(isPhishingResistantMechanism(mechanism)).toBe(false);
    });
  }
});

describe("mechanismSatisfies", () => {
  it("satisfies an empty requirement with any mechanism", () => {
    for (const mechanism of [...PHISHING_RESISTANT, ...PHISHABLE]) {
      expect(mechanismSatisfies(mechanism, {}).effect).toBe("satisfied");
    }
  });

  it("satisfies a phishing-resistance requirement only with a resistant mechanism", () => {
    for (const mechanism of PHISHING_RESISTANT) {
      expect(
        mechanismSatisfies(mechanism, { requirePhishingResistance: true })
          .effect,
      ).toBe("satisfied");
    }
  });

  it("refuses a phishing-resistance requirement from a phishable mechanism", () => {
    for (const mechanism of PHISHABLE) {
      const decision = mechanismSatisfies(mechanism, {
        requirePhishingResistance: true,
      });
      expect(decision.effect).toBe("refused");
      expect(decision.reasons).toContain("phishing_resistance_required");
      expect(decision.reasons).toContain(`mechanism_${mechanism}`);
    }
  });
});

describe("assertAssuranceCoherent", () => {
  it("refuses phishing_resistant assurance from a session re-auth (F13)", () => {
    expect(() =>
      assertAssuranceCoherent("session_reauth", "phishing_resistant"),
    ).toThrow(IncoherentAssuranceError);
  });

  it("refuses phishing_resistant assurance from an out-of-band code (F13)", () => {
    expect(() =>
      assertAssuranceCoherent("out_of_band", "phishing_resistant"),
    ).toThrow(IncoherentAssuranceError);
  });

  it("allows phishing_resistant assurance from webauthn and openid4vp", () => {
    for (const mechanism of PHISHING_RESISTANT) {
      expect(() =>
        assertAssuranceCoherent(mechanism, "phishing_resistant"),
      ).not.toThrow();
    }
  });

  it("allows a weaker assurance from any mechanism", () => {
    const weaker: readonly AssuranceLevel[] = [
      "provisional",
      "self_asserted",
      "verified",
      "mfa",
    ];
    for (const mechanism of [...PHISHING_RESISTANT, ...PHISHABLE]) {
      for (const assurance of weaker) {
        expect(() =>
          assertAssuranceCoherent(mechanism, assurance),
        ).not.toThrow();
      }
    }
  });

  it("names the mechanism and assurance it refused", () => {
    try {
      assertAssuranceCoherent("session_reauth", "phishing_resistant");
      expect.unreachable("should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(IncoherentAssuranceError);
      if (error instanceof IncoherentAssuranceError) {
        expect(error.mechanism).toBe("session_reauth");
        expect(error.assurance).toBe("phishing_resistant");
      }
    }
  });
});
