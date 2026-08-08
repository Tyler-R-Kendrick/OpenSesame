import { describe, expect, it } from "vitest";
import { fixtures } from "@opensesame/os-domain";
import { DEFAULT_VERIFIED_QUOTA, ProvisionalPolicy } from "../index.js";

describe("ProvisionalPolicy", () => {
  const policy = new ProvisionalPolicy();

  it("allows provisional low-risk actions under quota", () => {
    const d = policy.evaluate(
      fixtures.provisionalPrincipal(),
      {
        subject: { type: "principal", id: "prn_x" },
        action: "project.create_temporary",
        resource: { type: "project", id: "new" },
      },
      { temporaryProjects: 0, temporaryResources: 0, agents: 0 },
    );
    expect(d.effect).toBe("allow");
  });

  it("denies high-risk actions for provisional principals", () => {
    const d = policy.evaluate(fixtures.provisionalPrincipal(), {
      subject: { type: "principal", id: "prn_x" },
      action: "grant.export_raw_credential",
      resource: { type: "grant", id: "g1" },
    });
    expect(d.effect).toBe("deny");
    expect(d.reasons).toContain("high_risk_requires_explicit_authority");
  });

  it("denies high-risk actions for verified principals too", () => {
    for (const action of [
      "organization.delete",
      "grant.export_raw_credential",
      "admin.impersonate",
      "claim.force_complete",
    ]) {
      const d = policy.evaluate(fixtures.verifiedPrincipal(), {
        subject: { type: "principal", id: "prn_v" },
        action,
        resource: { type: "organization", id: "org_1" },
      });
      expect(d.effect, action).toBe("deny");
      expect(d.reasons).toContain("high_risk_requires_explicit_authority");
    }
  });

  it("holds verified principals to a larger quota, not to none", () => {
    const request = {
      subject: { type: "principal" as const, id: "prn_v" },
      action: "project.create_temporary",
      resource: { type: "project", id: "new" },
    };
    const verified = fixtures.verifiedPrincipal();
    expect(
      policy.evaluate(verified, request, {
        temporaryProjects: 4,
        temporaryResources: 0,
        agents: 0,
      }).effect,
    ).toBe("allow");
    const d = policy.evaluate(verified, request, {
      temporaryProjects: DEFAULT_VERIFIED_QUOTA.maxTemporaryProjects,
      temporaryResources: 0,
      agents: 0,
    });
    expect(d.effect).toBe("deny");
    expect(d.reasons).toContain("quota_projects");
  });

  it("enforces quotas", () => {
    const d = policy.evaluate(
      fixtures.provisionalPrincipal(),
      {
        subject: { type: "principal", id: "prn_x" },
        action: "project.create_temporary",
        resource: { type: "project", id: "new" },
      },
      { temporaryProjects: 3, temporaryResources: 0, agents: 0 },
    );
    expect(d.effect).toBe("deny");
    expect(d.reasons).toContain("provisional_quota_projects");
  });

  it("allows unlisted low-risk actions for verified principals", () => {
    const d = policy.evaluate(fixtures.verifiedPrincipal(), {
      subject: { type: "principal", id: "prn_v" },
      action: "resource.read",
      resource: { type: "resource", id: "res_1" },
    });
    expect(d.effect).toBe("allow");
    expect(d.reasons).toContain("assurance_not_provisional");
  });
});
