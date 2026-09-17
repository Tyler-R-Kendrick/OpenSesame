import type {
  AuthorityGrant,
  AuthorityGrantConstraints,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { grantToOpenFgaTuples } from "../authority-tuples.js";

function constraints(
  overrides: Partial<AuthorityGrantConstraints> = {},
): AuthorityGrantConstraints {
  return {
    audiences: ["host"],
    notBefore: null,
    expiresAt: new Date("2026-12-01T00:00:00Z"),
    requiredAssurance: null,
    authenticationMaxAgeSeconds: null,
    allowedNetworks: [],
    parameterRulesDigest: null,
    budgets: {},
    maximumDelegationDepth: 2,
    offlineUse: "forbidden",
    rawCredentialExport: false,
    ...overrides,
  };
}

function grant(overrides: Partial<AuthorityGrant> = {}): AuthorityGrant {
  return {
    id: "grn_1",
    version: 1,
    issuerPrincipalId: "prn_issuer",
    beneficiaryPrincipalId: "prn_bene",
    actorId: null,
    clientId: null,
    actorInstanceId: null,
    proofKeyThumbprint: null,
    organizationId: "org_1",
    projectId: "prj_1",
    environmentId: null,
    connectionId: "conn_1",
    actions: ["secret.read"],
    resources: ["vault/item/*"],
    constraints: constraints(),
    parentGrantId: null,
    delegationDepth: 0,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    revokedAt: null,
    ...overrides,
  };
}

describe("grantToOpenFgaTuples (GA-F-02)", () => {
  it("projects connection#user and project#viewer for a read grant", () => {
    const result = grantToOpenFgaTuples(grant());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tuples).toEqual([
      {
        user: "user:prn_bene",
        relation: "user",
        object: "connection:conn_1",
      },
      {
        user: "user:prn_bene",
        relation: "viewer",
        object: "project:prj_1",
      },
    ]);
  });

  it("raises project relation to developer for writeish actions", () => {
    const result = grantToOpenFgaTuples(
      grant({ actions: ["secret.write", "secret.read"] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tuples).toContainEqual({
      user: "user:prn_bene",
      relation: "developer",
      object: "project:prj_1",
    });
  });

  it("projects typed vault_item resources as reader/writer", () => {
    const result = grantToOpenFgaTuples(
      grant({
        connectionId: null,
        projectId: null,
        actions: ["item.read"],
        resources: ["vault_item:row_1"],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tuples).toEqual([
      {
        user: "user:prn_bene",
        relation: "reader",
        object: "vault_item:row_1",
      },
    ]);
  });

  it("refuses cohort-shaped resources (never a grantee)", () => {
    const result = grantToOpenFgaTuples(
      grant({
        resources: ["cohort:platform"],
        connectionId: null,
        projectId: null,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("cohort_grantee");
  });

  it("projects nothing for a revoked grant", () => {
    const result = grantToOpenFgaTuples(
      grant({ revokedAt: new Date("2026-09-02T00:00:00Z") }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("revoked");
  });

  it("refuses an unscoped grant with only opaque resources", () => {
    const result = grantToOpenFgaTuples(
      grant({
        connectionId: null,
        projectId: null,
        resources: ["vault/item/*"],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unmapped_scope");
  });
});
