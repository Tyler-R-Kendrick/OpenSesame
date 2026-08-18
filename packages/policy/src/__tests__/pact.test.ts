import { fixtures } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  assertAtMostWins,
  checkThenSetAdmitsDoubleClaim,
} from "@opensesame/testing";
import { DEFAULT_PROVISIONAL_QUOTA, ProvisionalPolicy } from "../index.js";

const claimReq = {
  subject: { type: "principal" as const, id: "prn_x" },
  action: "claim.create",
  resource: { type: "claim", id: "new" },
};

const emptyUsage = {
  temporaryProjects: 0,
  temporaryResources: 0,
  agents: 0,
  organizations: 0,
  oauthClients: 0,
  projects: 0,
  claims: 0,
};

describe("PACT — provisional quota fence", () => {
  it("property: claim.create is denied at the provisional cap", () => {
    const policy = new ProvisionalPolicy();
    const principal = fixtures.provisionalPrincipal();
    expect(policy.evaluate(principal, claimReq, emptyUsage).effect).toBe(
      "allow",
    );
    const denied = policy.evaluate(principal, claimReq, {
      ...emptyUsage,
      claims: DEFAULT_PROVISIONAL_QUOTA.maxClaims,
    });
    expect(denied.effect).toBe("deny");
    expect(denied.reasons).toContain("quota_claims");
  });

  it("adversarial: a check-then-set mutant admits a double claim", () => {
    checkThenSetAdmitsDoubleClaim();
  });

  it("chaos: every concurrent evaluator at the cap fails closed", async () => {
    const policy = new ProvisionalPolicy();
    const principal = fixtures.provisionalPrincipal();
    await assertAtMostWins(async () => {
      return (
        policy.evaluate(principal, claimReq, {
          ...emptyUsage,
          claims: DEFAULT_PROVISIONAL_QUOTA.maxClaims,
        }).effect === "allow"
      );
    }, 0);
  });
});
