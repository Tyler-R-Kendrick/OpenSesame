import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/schema/index.js";
import { makePrincipal } from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

/**
 * The repositories only exercise a subset of the schema. These round-trips
 * keep the remaining drizzle table definitions honest against the real
 * migrations: every insert+select below fails if the SQL DDL and the drizzle
 * column mapping drift apart.
 */
let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await createPgTestContext();
}, 60_000);

afterAll(async () => {
  await ctx.client.close();
});

describe("schema round-trips (tables without repositories)", () => {
  it("organizations, teams, projects, and memberships", async () => {
    const owner = await ctx.repos.principals.create(makePrincipal());

    const orgId = `org_${randomUUID()}`;
    await ctx.db.insert(schema.organizations).values({
      id: orgId,
      slug: `slug_${randomUUID()}`,
      displayName: "Acme",
      state: "active",
      createdBy: owner.id,
    });
    const [org] = await ctx.db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId));
    expect(org?.displayName).toBe("Acme");

    const teamId = `team_${randomUUID()}`;
    await ctx.db.insert(schema.teams).values({
      id: teamId,
      organizationId: orgId,
      slug: "eng",
      displayName: "Engineering",
    });
    const [team] = await ctx.db
      .select()
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId));
    expect(team?.organizationId).toBe(orgId);

    const projectId = `proj_${randomUUID()}`;
    await ctx.db.insert(schema.projects).values({
      id: projectId,
      kind: "standard",
      organizationId: orgId,
      ownerPrincipalId: owner.id,
      slug: "vault",
      displayName: "Vault",
      state: "active",
      sealedStoreTombName: "tomb-1",
      pagesVaultFolderId: "folder-1",
    });
    const [project] = await ctx.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));
    expect(project?.sealedStoreTombName).toBe("tomb-1");

    await ctx.db.insert(schema.projectMemberships).values({
      projectId,
      principalId: owner.id,
      role: "owner",
    });
    const memberships = await ctx.db
      .select()
      .from(schema.projectMemberships)
      .where(eq(schema.projectMemberships.projectId, projectId));
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe("owner");
  });

  it("resources and ownerships", async () => {
    const owner = await ctx.repos.principals.create(makePrincipal());
    const resourceId = `res_${randomUUID()}`;
    await ctx.db.insert(schema.resources).values({
      id: resourceId,
      kind: "connection",
      state: "active",
      ownerPrincipalId: owner.id,
      manifest: { host: "example.com" },
      version: 3,
    });
    const [resource] = await ctx.db
      .select()
      .from(schema.resources)
      .where(eq(schema.resources.id, resourceId));
    expect(resource?.manifest).toEqual({ host: "example.com" });
    expect(resource?.version).toBe(3);

    const ownershipId = `own_${randomUUID()}`;
    await ctx.db.insert(schema.ownerships).values({
      id: ownershipId,
      subjectType: "principal",
      subjectId: owner.id,
      objectType: "resource",
      objectId: resourceId,
      relation: "owner",
    });
    const [ownership] = await ctx.db
      .select()
      .from(schema.ownerships)
      .where(eq(schema.ownerships.id, ownershipId));
    expect(ownership?.relation).toBe("owner");
  });

  it("delegations reference principals and agents", async () => {
    const owner = await ctx.repos.principals.create(makePrincipal());
    const agentId = `agt_${randomUUID()}`;
    await ctx.db.insert(schema.agents).values({
      id: agentId,
      ownerPrincipalId: owner.id,
      displayName: "bot",
      state: "claimed",
    });
    const delegationId = `dlg_${randomUUID()}`;
    await ctx.db.insert(schema.delegations).values({
      id: delegationId,
      principalId: owner.id,
      agentId,
      relationship: "owns",
    });
    const [delegation] = await ctx.db
      .select()
      .from(schema.delegations)
      .where(eq(schema.delegations.id, delegationId));
    expect(delegation?.relationship).toBe("owns");
  });

  it("oauth clients, consents, and pairwise-adjacent lookups", async () => {
    const owner = await ctx.repos.principals.create(makePrincipal());
    const clientId = `cli_${randomUUID()}`;
    await ctx.db.insert(schema.oauthClients).values({
      id: clientId,
      ownerPrincipalId: owner.id,
      admissionMode: "pre_registered",
      displayName: "RP",
      redirectUris: ["https://rp.example/cb"],
      sectorIdentifier: "rp.example",
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none",
      allowedScopes: ["openid"],
      allowedResources: [],
      state: "active",
    });
    const [client] = await ctx.db
      .select()
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.id, clientId));
    expect(client?.redirectUris).toEqual(["https://rp.example/cb"]);

    const consentId = `con_${randomUUID()}`;
    await ctx.db.insert(schema.consents).values({
      id: consentId,
      principalId: owner.id,
      clientId,
      sectorIdentifier: "rp.example",
      scopes: ["openid"],
      resources: [],
      claims: [],
    });
    const [consent] = await ctx.db
      .select()
      .from(schema.consents)
      .where(eq(schema.consents.id, consentId));
    expect(consent?.scopes).toEqual(["openid"]);
  });

  it("provisional sessions and device authorization sessions", async () => {
    const owner = await ctx.repos.principals.create(makePrincipal());
    const sessionId = `ps_${randomUUID()}`;
    await ctx.db.insert(schema.provisionalSessions).values({
      id: sessionId,
      principalId: owner.id,
      quotaProfile: "default",
      allowedActions: ["claim"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const [session] = await ctx.db
      .select()
      .from(schema.provisionalSessions)
      .where(eq(schema.provisionalSessions.id, sessionId));
    expect(session?.allowedActions).toEqual(["claim"]);

    const clientId = `cli_${randomUUID()}`;
    await ctx.db.insert(schema.oauthClients).values({
      id: clientId,
      admissionMode: "pre_registered",
      displayName: "CLI",
      sectorIdentifier: "cli.example",
      tokenEndpointAuthMethod: "none",
      state: "active",
    });
    const deviceId = `dev_${randomUUID()}`;
    await ctx.db.insert(schema.deviceAuthorizationSessions).values({
      id: deviceId,
      clientId,
      deviceCodeDigest: new Uint8Array([1, 2]),
      userCodeDigest: new Uint8Array([3, 4]),
      requestedScopes: ["openid"],
      requestedResources: [],
      state: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const [device] = await ctx.db
      .select()
      .from(schema.deviceAuthorizationSessions)
      .where(eq(schema.deviceAuthorizationSessions.id, deviceId));
    // bytea custom type maps back to Uint8Array on read.
    expect(device?.deviceCodeDigest).toEqual(new Uint8Array([1, 2]));
    expect(device?.pollCount).toBe(0);
  });
});
