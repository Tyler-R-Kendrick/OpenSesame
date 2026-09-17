import type {
  AuthorityGrant,
  AuthorityGrantConstraints,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  planGrantTupleBackfill,
  planRealmTupleBackfill,
  planTupleBackfillRollback,
} from "../authority-tuple-backfill.js";

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

describe("authority tuple backfill plan (GA-F-04)", () => {
  it("plans writes for an active connection-scoped grant", () => {
    const plan = planGrantTupleBackfill(grant());
    expect(plan.quarantine).toBeNull();
    expect(plan.writes.length).toBeGreaterThan(0);
    expect(plan.writes.every((w) => w.op === "write")).toBe(true);
    expect(plan.writes[0]?.grantId).toBe("grn_1");
  });

  it("quarantines revoked grants instead of writing", () => {
    const plan = planGrantTupleBackfill(
      grant({ revokedAt: new Date("2026-09-02T00:00:00Z") }),
    );
    expect(plan.writes).toEqual([]);
    expect(plan.quarantine?.reason).toBe("revoked");
  });

  it("quarantines cohort-shaped resources", () => {
    const plan = planGrantTupleBackfill(
      grant({
        connectionId: null,
        projectId: null,
        resources: ["cohort:platform"],
      }),
    );
    expect(plan.writes).toEqual([]);
    expect(plan.quarantine?.reason).toBe("cohort_grantee");
  });

  it("aggregates a realm page and rolls back only planned writes", () => {
    const active = grant({ id: "grn_a" });
    const revoked = grant({
      id: "grn_b",
      revokedAt: new Date("2026-09-02T00:00:00Z"),
    });
    const realm = planRealmTupleBackfill([active, revoked]);
    expect(realm.quarantines).toHaveLength(1);
    expect(realm.quarantines[0]?.grantId).toBe("grn_b");
    expect(realm.writes.every((w) => w.grantId === "grn_a")).toBe(true);

    const rollback = planTupleBackfillRollback(realm.writes);
    expect(rollback.deletes).toHaveLength(realm.writes.length);
    expect(rollback.deletes.every((d) => d.op === "delete")).toBe(true);
  });
});
