import { fixtures } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVISIONAL_QUOTA,
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
    claims: 0,
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
      "principal.merge",
      "grant.export_raw_credential",
      "admin.impersonate",
      "oauth.client.register_privileged",
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

  it("caps live claims", () => {
    const d = policy.evaluate(
      fixtures.provisionalPrincipal(),
      {
        subject: { type: "principal", id: "prn_x" },
        action: "claim.create",
        resource: { type: "claim", id: "*" },
      },
      usage({ claims: 8 }),
    );
    expect(d.effect).toBe("deny");
    expect(d.reasons).toContain("provisional_quota_claims");
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

  it("allows a guest to create a standard project under quota", () => {
    const request = {
      subject: { type: "principal" as const, id: "prn_x" },
      action: "project.create",
      resource: { type: "project", id: "*" },
    };
    expect(
      policy.evaluate(fixtures.provisionalPrincipal(), request, usage({}))
        .effect,
    ).toBe("allow");
    const denied = policy.evaluate(
      fixtures.provisionalPrincipal(),
      request,
      usage({ projects: 3 }),
    );
    expect(denied.effect).toBe("deny");
    expect(denied.reasons).toContain("provisional_quota_projects");
    expect(denied.obligations).toContain("upgrade_identity");
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
      // The refusal is the allow-list, not the zero quota behind it: a later
      // widening of the quota must not quietly admit the action.
      expect(d.reasons, action).toContain("provisional_action_not_permitted");
      expect(d.reasons, action).toContain(action);
    }
  });

  it("admits every action on the provisional allow-list", () => {
    for (const action of [
      "project.create",
      "project.create_temporary",
      "resource.create_temporary",
      "resource.read",
      "claim.create",
      "agent.register_ephemeral",
      "session.continue_anonymous",
    ]) {
      const d = policy.evaluate(
        fixtures.provisionalPrincipal(),
        {
          subject: { type: "principal", id: "prn_x" },
          action,
          resource: { type: "resource", id: "res_1" },
        },
        usage({}),
      );
      expect(d.effect, action).toBe("allow");
    }
  });

  it("denies a provisional action that is on no list at all", () => {
    const d = policy.evaluate(
      fixtures.provisionalPrincipal(),
      {
        subject: { type: "principal", id: "prn_x" },
        action: "resource.delete",
        resource: { type: "resource", id: "res_1" },
      },
      usage({}),
    );
    expect(d.effect).toBe("deny");
    expect(d.reasons).toContain("provisional_action_not_permitted");
  });

  it("caps temporary resources and ephemeral agents", () => {
    const provisional = fixtures.provisionalPrincipal();
    const cases = [
      {
        action: "resource.create_temporary",
        at: usage({ temporaryResources: 10 }),
        under: usage({ temporaryResources: 9 }),
        reason: "quota_resources",
      },
      {
        action: "agent.register_ephemeral",
        at: usage({ agents: 2 }),
        under: usage({ agents: 1 }),
        reason: "quota_agents",
      },
    ];

    for (const { action, at, under, reason } of cases) {
      const request = {
        subject: { type: "principal" as const, id: "prn_x" },
        action,
        resource: { type: "resource", id: "*" },
      };
      expect(policy.evaluate(provisional, request, under).effect, action).toBe(
        "allow",
      );

      const denied = policy.evaluate(provisional, request, at);
      expect(denied.effect, action).toBe("deny");
      expect(denied.reasons, action).toContain(`provisional_${reason}`);
      expect(denied.reasons, action).toContain(reason);
      expect(denied.obligations, action).toContain("upgrade_identity");
    }
  });

  it("offers no upgrade path to a verified principal who is simply at quota", () => {
    const denied = policy.evaluate(
      fixtures.verifiedPrincipal(),
      {
        subject: { type: "principal", id: "prn_v" },
        action: "agent.register_ephemeral",
        resource: { type: "agent", id: "*" },
      },
      usage({ agents: DEFAULT_VERIFIED_QUOTA.maxAgents }),
    );
    expect(denied.effect).toBe("deny");
    expect(denied.reasons).toContain("quota_agents");
    expect(denied.reasons).not.toContain("provisional_quota_agents");
    // Upgrading identity is what clears a provisional cap; a verified principal
    // has nothing left to upgrade, so offering it would be a dead end.
    expect(denied.obligations).toBeUndefined();
  });

  // The default usage has to be real zeros rather than an empty object: an
  // absent count compares false against every limit, so a zero quota would
  // admit the first request it was meant to refuse.
  it("reads an omitted usage as zero, so a zero quota denies immediately", () => {
    const noClaims = new ProvisionalPolicy({
      ...DEFAULT_PROVISIONAL_QUOTA,
      maxClaims: 0,
    });
    const d = noClaims.evaluate(fixtures.provisionalPrincipal(), {
      subject: { type: "principal", id: "prn_x" },
      action: "claim.create",
      resource: { type: "claim", id: "*" },
    });
    expect(d.effect).toBe("deny");
    expect(d.reasons).toContain("provisional_quota_claims");
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
