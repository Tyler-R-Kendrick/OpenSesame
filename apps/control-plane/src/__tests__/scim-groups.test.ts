import {
  type ReferenceIdp,
  startReferenceIdp,
} from "@opensesame/mock-upstream-idp/testkit";
import { overlapCast } from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { putGroupRoleMapping } from "../routes/scim-groups.js";
import {
  memberIds,
  parseMemberSelector,
  resolveMemberIds,
} from "../routes/scim-member-selector.js";
import { provisionedRoleForSubject } from "../routes/scim.js";
import {
  DEFAULT_IDP_SUBJECT,
  PAGES_ORIGIN,
  groupsPath,
  joinTenant,
  mintOrgIdToken,
  mintScimToken,
  patchScim,
  provisionUser,
  provisional,
  seedTenant,
  testConfig,
  usersPath,
} from "./scim-test-helpers.js";

let idp: ReferenceIdp;

beforeAll(async () => {
  idp = await startReferenceIdp();
}, 30_000);

afterAll(async () => {
  await idp.close();
});

describe("SCIM member selector", () => {
  it("parses collection, value-eq, and unsupported filters", () => {
    expect(parseMemberSelector("members")).toEqual({ type: "collection" });
    expect(parseMemberSelector('members[value eq "abc"]')).toEqual({
      type: "valueEq",
      value: "abc",
    });
    expect(parseMemberSelector("members[value eq 'abc']")).toEqual({
      type: "valueEq",
      value: "abc",
    });
    expect(parseMemberSelector('members[display eq "x"]')).toEqual({
      type: "unsupported",
    });
    expect(
      parseMemberSelector('members[value eq "a" or value eq "b"]'),
    ).toEqual({ type: "unsupported" });
    expect(parseMemberSelector("displayName")).toBeUndefined();
  });

  it("reads member ids and resolves selector-only remove", () => {
    expect(memberIds([{ value: "a" }, { value: "b" }])).toEqual(["a", "b"]);
    expect(memberIds(undefined)).toEqual([]);
    expect(
      resolveMemberIds({
        op: "remove",
        path: 'members[value eq "abc"]',
      }),
    ).toEqual({ ids: ["abc"] });
    expect(resolveMemberIds({ op: "remove", path: "members" })).toEqual({
      error: {
        detail: "Bulk member removal is not supported.",
        scimType: "invalidValue",
      },
    });
  });
});

describe("SCIM Groups persistence", () => {
  it("ADV-20: selector-only members[value eq id] remove drops membership and privilege", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig(idp.issuer) });
    const { owner, org } = await seedTenant(app, "adv20-org", idp);
    const { token } = await mintScimToken(app, org.id, owner.accessToken);
    const { idToken, subject } = await mintOrgIdToken(idp, PAGES_ORIGIN);
    await putGroupRoleMapping(ctx, org.id, "owners", "owner");
    const created = await provisionUser(app, org.id, token, {
      userName: "ada@adv20.example",
      externalId: subject,
    });
    const guest = await provisional(app);
    expect(
      (await joinTenant(app, "adv20-org", guest.accessToken, idToken)).status,
    ).toBe(201);

    const added = await patchScim(app, groupsPath(org.id, "owners"), token, [
      { op: "add", path: "members", value: [{ value: created.body.id }] },
    ]);
    expect(added.status).toBe(200);
    expect(await provisionedRoleForSubject(ctx, org.id, subject)).toBe("owner");
    expect(
      (await ctx.stores.scim.groups.getById(org.id, "owners"))?.memberIds,
    ).toContain(created.body.id);

    const removed = await patchScim(app, groupsPath(org.id, "owners"), token, [
      { op: "remove", path: `members[value eq "${created.body.id}"]` },
    ]);
    expect(removed.status).toBe(200);
    expect(
      (await ctx.stores.scim.groups.getById(org.id, "owners"))?.memberIds,
    ).not.toContain(created.body.id);
    expect(
      await provisionedRoleForSubject(ctx, org.id, subject),
    ).toBeUndefined();
    expect(
      (await ctx.stores.organizationMemberships.find(org.id, guest.principalId))
        ?.role,
    ).toBe("member");

    const bulk = await patchScim(app, groupsPath(org.id, "owners"), token, [
      { op: "remove", path: "members" },
    ]);
    expect(bulk.status).toBe(400);
    expect(overlapCast(await bulk.json()).scimType).toBe("invalidValue");

    const badFilter = await patchScim(
      app,
      groupsPath(org.id, "owners"),
      token,
      [{ op: "remove", path: 'members[display eq "Ada"]' }],
    );
    expect(badFilter.status).toBe(400);
    expect(overlapCast(await badFilter.json()).scimType).toBe("invalidPath");
  }, 30_000);

  it("ADV-21: remaining mapped group keeps its role; unmapped owners grants nothing", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig(idp.issuer) });
    const { owner, org } = await seedTenant(app, "adv21-org", idp);
    const { token } = await mintScimToken(app, org.id, owner.accessToken);
    const { idToken, subject } = await mintOrgIdToken(idp, PAGES_ORIGIN);
    await putGroupRoleMapping(ctx, org.id, "leaders", "owner");
    await putGroupRoleMapping(ctx, org.id, "operators", "admin");
    const created = await provisionUser(app, org.id, token, {
      userName: "ada@adv21.example",
      externalId: subject,
    });
    const guest = await provisional(app);
    expect(
      (await joinTenant(app, "adv21-org", guest.accessToken, idToken)).status,
    ).toBe(201);

    await patchScim(app, groupsPath(org.id, "leaders"), token, [
      { op: "add", path: "members", value: [{ value: created.body.id }] },
    ]);
    await patchScim(app, groupsPath(org.id, "operators"), token, [
      { op: "add", path: "members", value: [{ value: created.body.id }] },
    ]);
    expect(await provisionedRoleForSubject(ctx, org.id, subject)).toBe("owner");

    const dropped = await patchScim(app, groupsPath(org.id, "leaders"), token, [
      { op: "remove", path: `members[value eq "${created.body.id}"]` },
    ]);
    expect(dropped.status).toBe(200);
    expect(await provisionedRoleForSubject(ctx, org.id, subject)).toBe("admin");
    expect(
      (await ctx.stores.organizationMemberships.find(org.id, guest.principalId))
        ?.role,
    ).toBe("admin");

    const namedOwners = await patchScim(
      app,
      groupsPath(org.id, "owners"),
      token,
      [{ op: "add", path: "members", value: [{ value: created.body.id }] }],
    );
    expect(namedOwners.status).toBe(200);
    expect(await provisionedRoleForSubject(ctx, org.id, subject)).toBe("admin");

    const onlyNamed = await provisionUser(app, org.id, token, {
      userName: "nobody@adv21.example",
    });
    await patchScim(app, groupsPath(org.id, "acme-owners"), token, [
      { op: "add", path: "members", value: [{ value: onlyNamed.body.id }] },
    ]);
    expect(
      await provisionedRoleForSubject(ctx, org.id, "nobody@adv21.example"),
    ).toBeUndefined();
  }, 30_000);

  it("ADV-22: changing externalId/username then deactivating still offboards", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig(idp.issuer) });
    const { owner, org } = await seedTenant(app, "adv22-org", idp);
    const { token } = await mintScimToken(app, org.id, owner.accessToken);
    idp.setSubject("adv22-user");
    const { idToken, subject } = await mintOrgIdToken(idp, PAGES_ORIGIN);
    idp.setSubject(DEFAULT_IDP_SUBJECT);

    const created = await provisionUser(app, org.id, token, {
      userName: "ada@adv22.example",
      externalId: subject,
    });
    const guest = await provisional(app);
    expect(
      (await joinTenant(app, "adv22-org", guest.accessToken, idToken)).status,
    ).toBe(201);
    expect(
      await ctx.stores.organizationMemberships.find(org.id, guest.principalId),
    ).toBeTruthy();

    const renamed = await patchScim(
      app,
      usersPath(org.id, `/${created.body.id}`),
      token,
      [
        {
          op: "replace",
          value: {
            userName: "ada.renamed@adv22.example",
            externalId: "directory-migrated-id",
          },
        },
      ],
    );
    expect(renamed.status).toBe(200);

    const deactivated = await patchScim(
      app,
      usersPath(org.id, `/${created.body.id}`),
      token,
      [{ op: "replace", path: "active", value: false }],
    );
    expect(deactivated.status).toBe(200);
    expect(
      await ctx.stores.organizationMemberships.find(org.id, guest.principalId),
    ).toBeUndefined();
    const stillSignedIn = await app.request("/v1/organizations", {
      headers: { authorization: `Bearer ${guest.accessToken}` },
    });
    expect(stillSignedIn.status).toBe(401);
  }, 30_000);
});
