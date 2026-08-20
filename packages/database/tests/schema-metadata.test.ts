import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema/index.js";
import { overlapCast } from "@opensesame/os-domain";

/**
 * Static contract for the drizzle schema: table names, foreign keys (with
 * delete behavior), and constraint presence. `getTableConfig` resolves the
 * lazy `references(() => ...)` arrows, so this is also the only place those
 * definitions are actually executed in unit tests.
 */
const EXPECTED_TABLES = [
  "principals",
  "external_identities",
  "better_auth_subjects",
  "organizations",
  "teams",
  "projects",
  "project_memberships",
  "resources",
  "ownerships",
  "agents",
  "agent_instances",
  "delegations",
  "oauth_clients",
  "client_origins",
  "client_claim_challenges",
  "pairwise_subjects",
  "consents",
  "provisional_sessions",
  "claim_sessions",
  "claim_items",
  "authorization_requests",
  "device_authorization_sessions",
  "audit_events",
  "outbox_events",
  "oidc_payloads",
] as const;

type PgTable = Parameters<typeof getTableConfig>[0];

function tables() {
  // Every export that getTableConfig accepts is a table; the rest (the
  // `schema` aggregate object) is skipped.
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    try {
      getTableConfig(overlapCast(value));
      out[key] = overlapCast(value);
    } catch {
      // not a table export
    }
  }
  return out;
}

describe("schema metadata contract", () => {
  it("exports exactly the expected tables", () => {
    const names = Object.values(tables()).map(
      (table) => getTableConfig(table).name,
    );
    expect([...names].sort()).toEqual([...EXPECTED_TABLES].sort());
  });

  it("wires cascade deletes from parent to child tables", () => {
    const fkTargets = (table: PgTable) =>
      getTableConfig(table).foreignKeys.map((fk) => ({
        target: fk.reference().foreignTable,
        onDelete: fk.onDelete,
      }));

    const identityFks = fkTargets(schema.externalIdentities);
    expect(identityFks).toEqual([
      { target: schema.principals, onDelete: "cascade" },
    ]);

    const membershipFks = fkTargets(schema.projectMemberships);
    expect(membershipFks).toContainEqual({
      target: schema.projects,
      onDelete: "cascade",
    });
    expect(membershipFks).toContainEqual({
      target: schema.principals,
      onDelete: "cascade",
    });

    expect(fkTargets(schema.claimItems)).toEqual([
      { target: schema.claimSessions, onDelete: "cascade" },
    ]);
    expect(fkTargets(schema.pairwiseSubjects)).toEqual([
      { target: schema.principals, onDelete: "cascade" },
    ]);
    expect(fkTargets(schema.betterAuthSubjects)).toEqual([
      { target: schema.principals, onDelete: "cascade" },
    ]);
    expect(fkTargets(schema.teams)).toEqual([
      { target: schema.organizations, onDelete: "cascade" },
    ]);
    expect(fkTargets(schema.agentInstances)).toEqual([
      { target: schema.agents, onDelete: "cascade" },
    ]);
    expect(fkTargets(schema.clientOrigins)).toEqual([
      { target: schema.oauthClients, onDelete: "cascade" },
    ]);
    expect(fkTargets(schema.clientClaimChallenges)).toContainEqual({
      target: schema.oauthClients,
      onDelete: "cascade",
    });
  });

  it("keeps optional parents as plain references (no cascade)", () => {
    const byTarget = (table: PgTable) =>
      getTableConfig(table).foreignKeys.map((fk) => ({
        target: fk.reference().foreignTable,
        onDelete: fk.onDelete,
      }));

    // Claim sessions reference their creators but must not cascade-delete.
    const claimFks = byTarget(schema.claimSessions);
    expect(claimFks.length).toBeGreaterThanOrEqual(4);
    for (const fk of claimFks) {
      expect(fk.onDelete).not.toBe("cascade");
    }

    // Projects reference organizations and owners without deleting them.
    const projectFks = byTarget(schema.projects);
    expect(projectFks).toContainEqual({
      target: schema.organizations,
      onDelete: "no action",
    });
    expect(projectFks).toContainEqual({
      target: schema.principals,
      onDelete: "no action",
    });
  });

  it("resolves every table's columns, indexes, checks, and foreign keys", () => {
    for (const table of Object.values(tables())) {
      const config = getTableConfig(table);
      expect(config.columns.length).toBeGreaterThan(0);
      // Accessing these resolves the lazy extra-config callbacks, including
      // the inline `references(() => ...)` arrows on FK columns.
      expect(Array.isArray(config.indexes)).toBe(true);
      expect(Array.isArray(config.checks)).toBe(true);
      expect(Array.isArray(config.uniqueConstraints)).toBe(true);
      expect(Array.isArray(config.foreignKeys)).toBe(true);
      // reference() executes the lazy `references(() => ...)` arrows.
      for (const fk of config.foreignKeys) {
        const ref = fk.reference();
        expect(ref.columns.length).toBeGreaterThan(0);
        expect(ref.foreignColumns.length).toBe(ref.columns.length);
      }
    }
  });

  it("guards the enum-like text columns with check constraints", () => {
    const checkNames = (table: PgTable) =>
      getTableConfig(table).checks.map((c) => c.name);

    expect(checkNames(schema.principals)).toEqual(
      expect.arrayContaining([
        "principals_state_check",
        "principals_assurance_check",
      ]),
    );
    expect(checkNames(schema.claimSessions)).toEqual(
      expect.arrayContaining([
        "claim_sessions_type_check",
        "claim_sessions_state_check",
      ]),
    );
    expect(checkNames(schema.auditEvents)).toContain(
      "audit_events_outcome_check",
    );
    expect(checkNames(schema.oauthClients)).toEqual(
      expect.arrayContaining([
        "oauth_clients_admission_mode_check",
        "oauth_clients_state_check",
      ]),
    );
  });

  it("keeps the unique constraints the repositories rely on", () => {
    const uniqueNames = (table: PgTable) =>
      getTableConfig(table)
        .indexes.filter((idx) => idx.config.unique)
        .map((idx) => idx.config.name);

    expect(uniqueNames(schema.externalIdentities)).toContain(
      "external_identities_kind_issuer_tenant_subject_uidx",
    );
    expect(uniqueNames(schema.claimSessions)).toContain(
      "claim_sessions_token_digest_uidx",
    );
    expect(uniqueNames(schema.pairwiseSubjects)).toContain(
      "pairwise_subjects_sector_subject_uidx",
    );
  });
});
