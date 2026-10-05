import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { createEventSealer } from "../src/event-seal.js";
import { createPostgresOrgFederationStores } from "../src/org-federation-store.js";
import { createPostgresOrganizationStores } from "../src/repos/postgres.js";
import { orgLdapConfig } from "../src/schema/index.js";
import { makePrincipal } from "./factories.js";
import { createPgTestContext } from "./pg-harness-full.js";

it("seals LDAP credentials and rejects transplantation between organizations", async () => {
  const ctx = await createPgTestContext();
  try {
    const principal = await ctx.repos.principals.create(makePrincipal());
    const organizations = createPostgresOrganizationStores(ctx.db);
    const stores = createPostgresOrgFederationStores(
      ctx.db,
      createEventSealer("ldap-test-key"),
    );
    for (const id of ["tenant-a", "tenant-b"]) {
      await organizations.organizations.set(id, {
        id,
        slug: id,
        displayName: id,
        state: "active",
        createdBy: principal.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await stores.ldapConfigs.put({
        organizationId: id,
        url: "ldaps://directory.example",
        bindMode: "search_bind",
        serviceBindSecret: "svc-secret",
        subjectAttribute: "uid",
        attributeMap: {},
        groupRoleMap: {},
      });
    }
    expect((await stores.ldapConfigs.get("tenant-a"))?.serviceBindSecret).toBe(
      "svc-secret",
    );
    expect(
      (await stores.ldapConfigs.list()).map((row) => row.serviceBindSecret),
    ).toEqual(["svc-secret", "svc-secret"]);
    const [raw] = await ctx.db
      .select()
      .from(orgLdapConfig)
      .where(eq(orgLdapConfig.organizationId, "tenant-a"));
    expect(raw?.serviceBindSecret).not.toContain("svc-secret");
    expect(raw?.serviceBindSecret).toContain("osev2.");
    await ctx.db
      .update(orgLdapConfig)
      .set({ serviceBindSecret: raw?.serviceBindSecret })
      .where(eq(orgLdapConfig.organizationId, "tenant-b"));
    await expect(stores.ldapConfigs.get("tenant-b")).rejects.toThrow(
      "could not be opened",
    );
  } finally {
    await ctx.client.close();
  }
}, 60_000);
