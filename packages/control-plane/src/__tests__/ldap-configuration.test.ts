import { randomBytes } from "node:crypto";
import { startReferenceLdapServer } from "@opensesame/mock-upstream-idp/ldap-server";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { ldapBind } from "../interactions/ldap.js";

describe("directory configuration updates", () => {
  it("preserves a write-only bind credential while keeping the saved directory usable", async () => {
    const serviceSecret = randomBytes(24).toString("base64url");
    const userSecret = randomBytes(24).toString("base64url");
    const directory = await startReferenceLdapServer({
      baseDn: "dc=example",
      entries: [
        {
          dn: "cn=service,dc=example",
          password: serviceSecret,
          attributes: { cn: ["service"], objectClass: ["applicationProcess"] },
        },
        {
          dn: "uid=alice,ou=people,dc=example",
          password: userSecret,
          attributes: {
            uid: ["alice"],
            cn: ["Alice"],
            mail: ["alice@example.com"],
            entryUUID: ["stable-alice-subject"],
            objectClass: ["inetOrgPerson"],
          },
        },
      ],
    });
    try {
      const { app, ctx } = createControlPlane();
      const created = await app.request("/v1/principals/provisional", {
        method: "POST",
      });
      const session: { principalId: string; accessToken: string } =
        await created.json();
      const now = ctx.clock();
      const id = "org:config";
      await ctx.stores.organizations.set(id, {
        id,
        slug: "config",
        displayName: "Config",
        state: "active",
        createdBy: session.principalId,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.stores.organizationMemberships.upsert({
        organizationId: id,
        principalId: session.principalId,
        role: "owner",
        createdAt: now,
        updatedAt: now,
      });
      const route = `/v1/organizations/${encodeURIComponent(id)}/ldap`;
      const headers = {
        authorization: `Bearer ${session.accessToken}`,
        "content-type": "application/json",
      };
      const config = {
        url: directory.url,
        bindMode: "search_bind",
        searchBaseDn: "ou=people,dc=example",
        searchFilter: "(uid={username})",
        serviceBindDn: "cn=service,dc=example",
        subjectAttribute: "entryUUID",
        attributeMap: { email: "mail", name: "cn" },
        groupRoleMap: {},
      };
      const first = await app.request(route, {
        method: "PUT",
        headers,
        body: JSON.stringify({ ...config, serviceBindSecret: serviceSecret }),
      });
      expect(first.status).toBe(200);
      expect(await first.text()).not.toContain(serviceSecret);
      const edited = await app.request(route, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          ...config,
          groupRoleMap: { engineers: "member" },
        }),
      });
      expect(edited.status).toBe(200);
      const read: {
        serviceBindConfigured: boolean;
        serviceBindSecret?: string;
      } = await edited.json();
      expect(read.serviceBindConfigured).toBe(true);
      expect(read.serviceBindSecret).toBeUndefined();
      const stored = await ctx.stores.orgFederation.ldapConfigs.get(id);
      if (!stored) throw new Error("Expected stored LDAP configuration");
      expect(stored.serviceBindSecret).toBe(serviceSecret);
      expect(await ldapBind(ctx, stored, "alice", userSecret)).toMatchObject({
        ok: true,
        subject: "stable-alice-subject",
        email: "alice@example.com",
      });
      // A host or service account change must explicitly supply its credential.
      const hostChanged = await app.request(route, {
        method: "PUT",
        headers,
        body: JSON.stringify({ ...config, url: "ldap://another.example:389" }),
      });
      expect(hostChanged.status).toBe(400);
      const dnChanged = await app.request(route, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          ...config,
          serviceBindDn: "cn=other,dc=example",
        }),
      });
      expect(dnChanged.status).toBe(400);
      expect(
        (await ctx.stores.orgFederation.ldapConfigs.get(id))?.serviceBindSecret,
      ).toBe(serviceSecret);

      const anonymous = await app.request(route, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      });
      expect(anonymous.status).toBe(401);
      await ctx.stores.organizationMemberships.upsert({
        organizationId: id,
        principalId: session.principalId,
        role: "member",
        createdAt: now,
        updatedAt: now,
      });
      const member = await app.request(route, {
        method: "PUT",
        headers,
        body: JSON.stringify(config),
      });
      expect(member.status).toBe(403);
      expect(
        (await ctx.stores.orgFederation.ldapConfigs.get(id))?.serviceBindSecret,
      ).toBe(serviceSecret);
    } finally {
      await directory.close();
    }
  });
});
