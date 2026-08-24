import { fixtures } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVISIONAL_QUOTA,
  ProvisionalPolicy,
  type ProvisionalUsage,
  quotaFieldFor,
} from "../index.js";

/**
 * Atomic units for the provisional authorization policy.
 *
 * `provisional.ts` sits in the Stryker `mutate` set at a 100% threshold, and
 * was the one file in that set below it — 25 mutants survived, all of them in
 * the parts of the policy that decide what an *anonymous* principal may do.
 * The existing suite covers the shapes of the rules; these pin the membership
 * of the lists themselves.
 *
 * That distinction is the whole point here. A test that a "high-risk action is
 * denied" still passes when `principal.merge` silently drops out of the
 * high-risk set — the rule works, the list no longer contains the dangerous
 * thing. In an authorization fabric the membership *is* the policy, so each
 * entry gets its own assertion.
 *
 * This matters directly for federated sign-in: a first-time visitor is admitted
 * as a provisional principal holding exactly these actions, and stays that way
 * until an upstream assertion promotes them.
 */

const usage = (over: Partial<ProvisionalUsage> = {}): ProvisionalUsage => ({
  temporaryProjects: 0,
  temporaryResources: 0,
  agents: 0,
  organizations: 0,
  oauthClients: 0,
  projects: 0,
  claims: 0,
  ...over,
});

const QUOTA_FIELD_BY_USAGE = {
  temporaryProjects: "maxTemporaryProjects",
  temporaryResources: "maxTemporaryResources",
  agents: "maxAgents",
  claims: "maxClaims",
  projects: "maxProjects",
} satisfies Record<
  "temporaryProjects" | "temporaryResources" | "agents" | "claims" | "projects",
  keyof typeof DEFAULT_PROVISIONAL_QUOTA
>;

const policy = new ProvisionalPolicy();

/**
 * A whole request, not just an action string. The policy only reads `action`
 * today, but passing a partial would quietly keep passing if it ever started
 * consulting the subject or resource — and this suite exists precisely to
 * catch the policy changing underneath its tests.
 */
function request(action: string) {
  return {
    subject: { type: "principal", id: "prn_x" },
    action,
    resource: { type: "project", id: "new" },
  } as const;
}

/**
 * Every action in the high-risk set, named individually. Losing any one of
 * these from the set is a privilege escalation that a "some high-risk action is
 * denied" test cannot see.
 */
const HIGH_RISK = [
  "organization.delete",
  "principal.merge",
  "grant.export_raw_credential",
  "admin.impersonate",
  "oauth.client.register_privileged",
  "claim.force_complete",
] as const;

/** Every action a provisional principal is permitted, named individually. */
const PROVISIONAL_ALLOWED = [
  "project.create",
  "project.create_temporary",
  "resource.create_temporary",
  "resource.read",
  "claim.create",
  "agent.register_ephemeral",
  "session.continue_anonymous",
] as const;

describe("the high-risk deny list, entry by entry", () => {
  it.each(HIGH_RISK)("denies %s for a provisional principal", (action) => {
    const d = policy.evaluate(
      fixtures.provisionalPrincipal(),
      request(action),
      usage(),
    );
    expect(d.effect).toBe("deny");
    expect(d.reasons).toEqual([
      "high_risk_requires_explicit_authority",
      action,
    ]);
  });

  it.each(HIGH_RISK)("denies %s for a verified principal too", (action) => {
    const d = policy.evaluate(
      fixtures.verifiedPrincipal(),
      request(action),
      usage(),
    );
    expect(d.effect).toBe("deny");
    expect(d.reasons).toEqual([
      "high_risk_requires_explicit_authority",
      action,
    ]);
  });
});

describe("the provisional allow list, entry by entry", () => {
  it.each(PROVISIONAL_ALLOWED)(
    "lets a provisional principal do %s while under quota",
    (action) => {
      const d = policy.evaluate(
        fixtures.provisionalPrincipal(),
        request(action),
        usage(),
      );
      expect(d.effect).toBe("allow");
      expect(d.reasons).toEqual(["provisional_policy_allow"]);
    },
  );

  it("refuses an action that is neither high-risk nor on the list", () => {
    // organization.create is a real action, not high-risk, and deliberately
    // outside a guest's reach — the fence between "anonymous" and "durable".
    const d = policy.evaluate(
      fixtures.provisionalPrincipal(),
      request("organization.create"),
      usage(),
    );
    expect(d.effect).toBe("deny");
    expect(d.reasons).toEqual([
      "provisional_action_not_permitted",
      "organization.create",
    ]);
  });

  it("names the refused action in the reasons, not just the rule", () => {
    // An audit line saying only "not permitted" cannot be investigated.
    const d = policy.evaluate(
      fixtures.provisionalPrincipal(),
      request("some.unlisted.action"),
      usage(),
    );
    expect(d.reasons).toHaveLength(2);
    expect(d.reasons[1]).toBe("some.unlisted.action");
  });

  it("lets a verified principal do what a provisional one cannot", () => {
    const d = policy.evaluate(
      fixtures.verifiedPrincipal(),
      request("organization.create"),
      usage(),
    );
    expect(d.effect).toBe("allow");
  });
});

describe("quota mapping for each metered action", () => {
  it.each([
    ["project.create_temporary", "temporaryProjects", "quota_projects"],
    ["resource.create_temporary", "temporaryResources", "quota_resources"],
    ["agent.register_ephemeral", "agents", "quota_agents"],
    ["claim.create", "claims", "quota_claims"],
    ["project.create", "projects", "quota_projects"],
  ] as const)(
    "%s spends %s and denies with %s at the limit",
    (action, field, reason) => {
      const limit = DEFAULT_PROVISIONAL_QUOTA[QUOTA_FIELD_BY_USAGE[field]];

      // One under the limit still passes ...
      expect(
        policy.evaluate(
          fixtures.provisionalPrincipal(),
          request(action),
          usage({ [field]: limit - 1 }),
        ).effect,
      ).toBe("allow");

      // ... and at the limit it is refused, naming the resource that ran out.
      const denied = policy.evaluate(
        fixtures.provisionalPrincipal(),
        request(action),
        usage({ [field]: limit }),
      );
      expect(denied.effect).toBe("deny");
      expect(denied.reasons).toEqual([`provisional_${reason}`, reason]);
    },
  );

  it("spends nothing for an action with no quota mapping", () => {
    // resource.read is allowed and unmetered: no usage figure should be able
    // to refuse it, or a guest could be locked out of reading by unrelated use.
    const d = policy.evaluate(
      fixtures.provisionalPrincipal(),
      request("resource.read"),
      usage({
        temporaryProjects: 9_999,
        temporaryResources: 9_999,
        agents: 9_999,
        claims: 9_999,
        projects: 9_999,
      }),
    );
    expect(d.effect).toBe("allow");
  });
});

describe("who is told they can fix a quota denial", () => {
  it("offers a provisional principal the upgrade that would clear it", () => {
    const d = policy.evaluate(
      fixtures.provisionalPrincipal(),
      request("agent.register_ephemeral"),
      usage({ agents: DEFAULT_PROVISIONAL_QUOTA.maxAgents }),
    );
    expect(d.effect).toBe("deny");
    expect(d.obligations).toEqual(["upgrade_identity"]);
  });

  it("does not dangle that upgrade in front of a verified principal", () => {
    // They already upgraded. Telling them to do it again is advice they
    // cannot act on, and it would mask a genuine capacity problem.
    const verifiedPolicy = new ProvisionalPolicy(DEFAULT_PROVISIONAL_QUOTA, {
      ...DEFAULT_PROVISIONAL_QUOTA,
      maxAgents: 1,
    });
    const d = verifiedPolicy.evaluate(
      fixtures.verifiedPrincipal(),
      request("agent.register_ephemeral"),
      usage({ agents: 1 }),
    );
    expect(d.effect).toBe("deny");
    expect(d.reasons).toEqual(["quota_agents"]);
    expect(d.obligations).toBeUndefined();
  });
});

describe("the default usage argument", () => {
  it("counts as zero of everything, not as unknown", () => {
    // Called without a usage figure, a zero limit must still refuse. If the
    // default were an empty object the comparison would be `undefined >= 0`,
    // which is false, and a zero quota would silently permit everything.
    const zeroQuota = new ProvisionalPolicy({
      ...DEFAULT_PROVISIONAL_QUOTA,
      maxProjects: 0,
    });
    const d = zeroQuota.evaluate(
      fixtures.provisionalPrincipal(),
      request("project.create"),
    );
    expect(d.effect).toBe("deny");
    expect(d.reasons).toEqual(["provisional_quota_projects", "quota_projects"]);
  });
});

describe("the action-to-quota mapping table", () => {
  it.each([
    ["project.create_temporary", "temporaryProjects", "maxTemporaryProjects"],
    [
      "resource.create_temporary",
      "temporaryResources",
      "maxTemporaryResources",
    ],
    ["agent.register_ephemeral", "agents", "maxAgents"],
    ["organization.create", "organizations", "maxOrganizations"],
    ["project.create", "projects", "maxProjects"],
    ["oauth.client.register", "oauthClients", "maxOAuthClients"],
    ["claim.create", "claims", "maxClaims"],
  ] as const)("maps %s to %s/%s", (action, usageField, limitField) => {
    expect(quotaFieldFor(action)).toMatchObject({
      usage: usageField,
      limit: limitField,
    });
  });

  it.each([
    "resource.read",
    "session.continue_anonymous",
    "some.action.nobody.has.heard.of",
  ])("answers exactly null — not undefined — for %s", (action) => {
    // The caller only checks truthiness, so `undefined` would behave the same
    // and a broken table would be invisible. Asserting the exact value is what
    // makes "this action spends nothing" a checked claim rather than a hope.
    expect(quotaFieldFor(action)).toBeNull();
  });
});
