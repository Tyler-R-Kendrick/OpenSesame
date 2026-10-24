import type { UpdateOrganizationRequest } from "@opensesame/contracts";
import {
  type Database,
  PostgresRepositories,
  createMemoryOrganizationStores,
  createPostgresOrganizationStores,
} from "@opensesame/database";
import * as schema from "@opensesame/database/schema";
import { type Organization, overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { resolveTrustedIssuer } from "../interactions/trust.js";
import {
  parseOrganizationIssuerAssignments,
  withApprovedOrganizationFederation,
} from "../organization-issuer-assignments.js";
import { migratedPGlite, warmMigratedPGlite } from "./migrated-pglite.js";

const VICTIM = "https://victim.example/tenant";
const native = {
  samlIssuer: "urn:example:victim",
  samlMetadataXml: '<EntityDescriptor entityID="urn:example:victim"/>',
};
function organization(
  id: string,
  fields: Partial<Organization> = {},
): Organization {
  return {
    id,
    slug: id.replace(":", "-"),
    displayName: id,
    state: "active",
    createdBy: "prn_owner",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...fields,
  };
}
async function owner() {
  const { app, ctx } = createControlPlane();
  const minted = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  const session: { principalId: string; accessToken: string } =
    await minted.json();
  const headers = {
    authorization: `Bearer ${session.accessToken}`,
    "content-type": "application/json",
  };
  const linked = await app.request("/v1/principals/link-identities", {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "oidc",
      issuer: "https://mock.example",
      subject: session.principalId,
      assurance: "verified",
    }),
  });
  expect(linked.status).toBe(201);
  const created = await app.request("/v1/organizations", {
    method: "POST",
    headers,
    body: JSON.stringify({ slug: "issuer-owner", displayName: "Owner" }),
  });
  expect(created.status).toBe(201);
  const org: { id: string } = await created.json();
  const patch = (body: UpdateOrganizationRequest) =>
    app.request(`/v1/organizations/${encodeURIComponent(org.id)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
  return { app, ctx, org, patch, headers };
}
describe("operator-approved organization issuer assignments", () => {
  it("rejects verified-principal preclaims without reserving either issuer column", async () => {
    const { app, ctx, patch, headers } = await owner();
    for (const fields of [
      { ssoIssuer: VICTIM },
      { samlIssuer: `${VICTIM}/` },
      native,
      { samlMetadataXml: native.samlMetadataXml },
      { samlMetadataUrl: `${VICTIM}/metadata` },
    ]) {
      const response = await patch(fields);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: "issuer_assignment_required",
      });
    }
    const created = await app.request("/v1/organizations", {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "preclaim",
        displayName: "Preclaim",
        ssoIssuer: VICTIM,
      }),
    });
    expect(created.status).toBe(403);
    expect(await ctx.stores.organizations.findByIssuer(VICTIM)).toBeUndefined();
    expect(await resolveTrustedIssuer(ctx, VICTIM)).toBeUndefined();
  });
  it("allows approved setup and ordinary edits but requires approval on retarget or metadata change", async () => {
    const { ctx, org, patch } = await owner();
    ctx.config.organizationIssuerAssignments?.push({
      organizationId: org.id,
      ssoIssuer: VICTIM,
      ...native,
    });
    expect(
      (
        await patch({
          ssoIssuer: `${VICTIM}/`,
          ssoClientId: "client",
          ...native,
        })
      ).status,
    ).toBe(200);
    expect(await resolveTrustedIssuer(ctx, VICTIM)).toMatchObject({
      source: "org",
      organizationId: org.id,
    });
    expect((await patch({ displayName: "Renamed" })).status).toBe(200);
    expect((await patch({ ssoIssuer: "https://other.example" })).status).toBe(
      403,
    );
    expect(
      (
        await patch({
          samlMetadataXml:
            '<EntityDescriptor entityID="urn:example:attacker"/>',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await patch({
          ssoIssuer: null,
          samlIssuer: null,
          samlMetadataXml: null,
        })
      ).status,
    ).toBe(200);
    expect(await resolveTrustedIssuer(ctx, VICTIM)).toBeUndefined();
  });
  it("deactivates legacy claims on every read without blocking an approved claimant", async () => {
    const raw = createMemoryOrganizationStores().organizations;
    raw.set(
      "org:squatter",
      organization("org:squatter", {
        ssoIssuer: VICTIM,
        ssoClientId: "evil",
        ssoClientSecret: "evil",
        ...native,
      }),
    );
    raw.set(
      "org:victim",
      organization("org:victim", { samlIssuer: `${VICTIM}/` }),
    );
    const store = withApprovedOrganizationFederation(raw, [
      { organizationId: "org:victim", samlIssuer: VICTIM },
    ]);
    for (const result of [
      await store.get("org:squatter"),
      await store.getBySlug("org-squatter"),
      ...(await store.listByCreator("prn_owner")),
    ]) {
      if (result?.id !== "org:squatter") continue;
      for (const key of [
        "ssoIssuer",
        "ssoClientId",
        "ssoClientSecret",
        "samlIssuer",
        "samlMetadataXml",
      ])
        expect(result).not.toHaveProperty(key);
    }
    expect((await store.findByIssuer(`${VICTIM}///`))?.id).toBe("org:victim");
    expect(await store.findByIssuer(native.samlIssuer)).toBeUndefined();
    const reloaded = withApprovedOrganizationFederation(raw, []);
    expect((await reloaded.get("org:victim"))?.samlIssuer).toBeUndefined();
    expect(await reloaded.findByIssuer(VICTIM)).toBeUndefined();
    expect(raw.get("org:squatter")?.ssoIssuer).toBe(VICTIM);
  });
  it("fails startup on malformed or ambiguous operator assignments", () => {
    for (const value of [
      "{}",
      "not-json",
      JSON.stringify([{ organizationId: "org:a", samlMetadataXml: "xml" }]),
      JSON.stringify([
        { organizationId: "org:a", ssoIssuer: VICTIM },
        { organizationId: "org:b", samlIssuer: `${VICTIM}/` },
      ]),
    ]) {
      expect(() => parseOrganizationIssuerAssignments(value)).toThrow();
    }
    expect(parseOrganizationIssuerAssignments(undefined)).toEqual([]);
  });
});
describe("durable issuer assignments", () => {
  beforeAll(warmMigratedPGlite, 60_000);
  it("filters persisted legacy claims after restart without blocking an approved tenant", async () => {
    const client = await migratedPGlite();
    try {
      const db: Database = overlapCast(drizzle(client, { schema }));
      const repos = new PostgresRepositories(db);
      const now = new Date();
      await repos.principals.create({
        id: "prn_owner",
        state: "active",
        assurance: "verified",
        createdAt: now,
        updatedAt: now,
        verifiedAt: now,
        version: 1,
      });
      const first = createPostgresOrganizationStores(db).organizations;
      await first.set(
        "org:squatter",
        organization("org:squatter", { ssoIssuer: VICTIM, ...native }),
      );
      await first.set(
        "org:victim",
        organization("org:victim", { ssoIssuer: VICTIM }),
      );
      const restarted = withApprovedOrganizationFederation(
        createPostgresOrganizationStores(db).organizations,
        [{ organizationId: "org:victim", ssoIssuer: VICTIM }],
      );
      expect(
        (await restarted.getBySlug("org-squatter"))?.samlMetadataXml,
      ).toBeUndefined();
      expect((await restarted.findByIssuer(VICTIM))?.id).toBe("org:victim");
      expect(await restarted.findByIssuer(native.samlIssuer)).toBeUndefined();
    } finally {
      await client.close();
    }
  }, 30_000);
});
