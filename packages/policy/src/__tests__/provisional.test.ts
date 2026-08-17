import { fixtures } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VERIFIED_QUOTA,
  ProvisionalPolicy,
  type ProvisionalUsage,
} from "../index.js";

describe("ProvisionalPolicy", () => {
  const policy = new ProvisionalPolicy();

  const usage = (over: Partial<ProvisionalUsage>): ProvisionalUsage => ({
    temporaryProjects: 0,
    temporaryResources: 0,
    agents: 0,
    organizations: 0,
    oauthClients: 0,
    projects: 0,
    ...over,
  });

  it("allows provisional low-risk actions under quota", () => {
    const d = policy.evaluate(
      fixtures.provisionalPrincipal(),
      {
        subject: { type: "principal", id: "prn_x" },
        action: "project.create_temporary",
        resource: { type: "project", id: "new" },
      },
      usage({}),
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
      policy.evaluate(verified, request, usage({ temporaryProjects: 4 }))
        .effect,
    ).toBe("allow");
    const d = policy.evaluate(
      verified,
      request,
      usage({ temporaryProjects: DEFAULT_VERIFIED_QUOTA.maxTemporaryProjects }),
    );
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
      usage({ temporaryProjects: 3 }),
    );
    expect(d.effect).toBe("deny");
    expect(d.reasons).toContain("provisional_quota_projects");
  });

  it("caps organizations and OAuth clients for verified principals", () => {
    const verified = fixtures.verifiedPrincipal();
    const orgRequest = {
      subject: { type: "principal" as const, id: "prn_v" },
      action: "organization.create",
      resource: { type: "organization", id: "*" },
    };
    expect(
      policy.evaluate(verified, orgRequest, usage({ organizations: 1 })).effect,
    ).toBe("allow");
    const orgDenied = policy.evaluate(
      verified,
      orgRequest,
      usage({ organizations: DEFAULT_VERIFIED_QUOTA.maxOrganizations }),
    );
    expect(orgDenied.effect).toBe("deny");
    expect(orgDenied.reasons).toContain("quota_organizations");

    const clientRequest = {
      subject: { type: "principal" as const, id: "prn_v" },
      action: "oauth.client.register",
      resource: { type: "oauth_client", id: "*" },
    };
    expect(
      policy.evaluate(verified, clientRequest, usage({ oauthClients: 3 }))
        .effect,
    ).toBe("allow");
    const clientDenied = policy.evaluate(
      verified,
      clientRequest,
      usage({ oauthClients: DEFAULT_VERIFIED_QUOTA.maxOAuthClients }),
    );
    expect(clientDenied.effect).toBe("deny");
    expect(clientDenied.reasons).toContain("quota_oauth_clients");
  });

  it("gives a provisional principal no organization or client allowance", () => {
    for (const action of ["organization.create", "oauth.client.register"]) {
      const d = policy.evaluate(
        fixtures.provisionalPrincipal(),
        {
          subject: { type: "principal", id: "prn_x" },
          action,
          resource: { type: "organization", id: "*" },
        },
        usage({}),
      );
      expect(d.effect, action).toBe("deny");
    }
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
