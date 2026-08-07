import { describe, expect, it } from "vitest";
import { fixtures } from "@opensesame/os-domain";
import { ProvisionalPolicy } from "../index.js";

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
    expect(d.reasons).toContain("provisional_denies_high_risk");
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

  it("does not restrict verified principals", () => {
    const d = policy.evaluate(fixtures.verifiedPrincipal(), {
      subject: { type: "principal", id: "prn_v" },
      action: "organization.delete",
      resource: { type: "organization", id: "org_1" },
    });
    expect(d.effect).toBe("allow");
    expect(d.reasons).toContain("not_provisional");
  });
});
