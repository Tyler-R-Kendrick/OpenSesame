import { describe, expect, it } from "vitest";
import {
  AccessLeaseSchema,
  AuthorityGrantSchema,
  AuthorityRecordSchema,
} from "../authority-grant.js";

const validGrant = {
  id: "grn_1",
  version: 1,
  issuer_principal_id: "prn_issuer",
  beneficiary_principal_id: "prn_bene",
  actor_id: null,
  client_id: null,
  actor_instance_id: null,
  proof_key_thumbprint: null,
  organization_id: "org_1",
  project_id: "prj_1",
  environment_id: null,
  connection_id: "conn_1",
  actions: ["secret.read"],
  resources: ["vault/item/*"],
  constraints: {
    audiences: ["host"],
    not_before: null,
    expires_at: "2026-12-01T00:00:00Z",
    required_assurance: null,
    authentication_max_age_seconds: null,
    allowed_networks: [],
    parameter_rules_digest: null,
    budgets: { invokes: 10 },
    maximum_delegation_depth: 2,
    offline_use: "forbidden",
    raw_credential_export: false,
  },
  parent_grant_id: null,
  delegation_depth: 0,
  created_at: "2026-09-01T00:00:00Z",
  revoked_at: null,
} as const;

describe("authority grant wire schema (GA-A-04)", () => {
  it("parses a Host-shaped Grant record", () => {
    const parsed = AuthorityGrantSchema.parse(validGrant);
    expect(parsed.id).toBe("grn_1");
    expect(parsed.constraints.maximum_delegation_depth).toBe(2);
    expect(parsed.constraints.budgets).toEqual({ invokes: 10 });
  });

  it("AccessLease and AuthorityRecord are the same schema (INV-GA-08 naming)", () => {
    expect(AccessLeaseSchema).toBe(AuthorityGrantSchema);
    expect(AuthorityRecordSchema).toBe(AuthorityGrantSchema);
    expect(AccessLeaseSchema.parse(validGrant).id).toBe("grn_1");
  });

  it("refuses secret-shaped unknown keys (INV-GA-02)", () => {
    expect(
      AuthorityGrantSchema.safeParse({
        ...validGrant,
        access_token: "leak",
      }).success,
    ).toBe(false);
    expect(
      AuthorityGrantSchema.safeParse({
        ...validGrant,
        constraints: {
          ...validGrant.constraints,
          password: "leak",
        },
      }).success,
    ).toBe(false);
  });

  it("refuses depth above the product ceiling", () => {
    expect(
      AuthorityGrantSchema.safeParse({
        ...validGrant,
        constraints: {
          ...validGrant.constraints,
          maximum_delegation_depth: 3,
        },
      }).success,
    ).toBe(false);
    expect(
      AuthorityGrantSchema.safeParse({
        ...validGrant,
        delegation_depth: 3,
      }).success,
    ).toBe(false);
  });

  it("refuses empty actions or resources", () => {
    expect(
      AuthorityGrantSchema.safeParse({
        ...validGrant,
        actions: [],
      }).success,
    ).toBe(false);
    expect(
      AuthorityGrantSchema.safeParse({
        ...validGrant,
        resources: [],
      }).success,
    ).toBe(false);
  });
});
