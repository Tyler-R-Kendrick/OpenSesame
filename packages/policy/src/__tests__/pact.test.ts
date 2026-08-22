import { fixtures } from "@opensesame/os-domain";
import {
  assertAtMostWins,
  checkThenSetAdmitsDoubleClaim,
} from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROVISIONAL_QUOTA, ProvisionalPolicy } from "../index.js";

const claimReq = {
  subject: { type: "principal" as const, id: "prn_x" },
  action: "claim.create",
  resource: { type: "claim", id: "new" },
};

const projectCreateReq = {
  subject: { type: "principal" as const, id: "prn_x" },
  action: "project.create",
  resource: { type: "project", id: "*" },
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

  it("contract: a guest may create a standard project under quota without upgrading", () => {
    const policy = new ProvisionalPolicy();
    const principal = fixtures.provisionalPrincipal();
    const allowed = policy.evaluate(principal, projectCreateReq, emptyUsage);
    expect(allowed.effect).toBe("allow");
    expect(allowed.reasons).toContain("provisional_policy_allow");
    const denied = policy.evaluate(principal, projectCreateReq, {
      ...emptyUsage,
      projects: DEFAULT_PROVISIONAL_QUOTA.maxProjects,
    });
    expect(denied.effect).toBe("deny");
    expect(denied.reasons).toContain("provisional_quota_projects");
    expect(denied.obligations).toContain("upgrade_identity");
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
