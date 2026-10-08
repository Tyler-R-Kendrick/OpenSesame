import { randomUUID } from "node:crypto";
import {
  type ReferenceIdp,
  startReferenceIdp,
} from "@opensesame/mock-upstream-idp/testkit";
import { overlapCast } from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { provisionedRoleForSubject } from "../routes/scim.js";
import {
  PAGES_ORIGIN,
  groupsPath,
  joinTenant,
  json,
  mintOrgIdToken,
  mintScimToken,
  patchScim,
  provisionUser,
  provisional,
  seedTenant,
  testConfig,
} from "./scim-test-helpers.js";

let idp: ReferenceIdp;
beforeAll(async () => {
  idp = await startReferenceIdp();
}, 30_000);
afterAll(async () => {
  await idp.close();
});

async function tenantFixture() {
  const plane = createControlPlane({
    processEnv: { NODE_ENV: "test", OPENSESAME_ALLOW_DEV_DEFAULTS: "1" },
    config: { ...testConfig(idp.issuer), corsOrigins: [PAGES_ORIGIN] },
  });
  const slug = `scim-outcomes-${randomUUID()}`;
  const { owner, org } = await seedTenant(plane.app, slug, idp);
  const { token } = await mintScimToken(plane.app, org.id, owner.accessToken);
  const { idToken, subject } = await mintOrgIdToken(idp, PAGES_ORIGIN);
  const user = await provisionUser(plane.app, org.id, token, {
    userName: "member@outcomes.example",
    externalId: subject,
  });
  expect(user.status).toBe(201);
  const member = await provisional(plane.app);
  expect(
    (await joinTenant(plane.app, slug, member.accessToken, idToken)).status,
  ).toBe(201);
  return {
    ...plane,
    owner,
    org,
    token,
    subject,
    userId: String(user.body.id),
    member,
  };
}
type Fixture = Awaited<ReturnType<typeof tenantFixture>>;

function mapping(
  f: Fixture,
  group: string,
  role: string,
  token = f.owner.accessToken,
) {
  return f.app.request(`/v1/organizations/${f.org.id}/scim/mappings/${group}`, {
    method: "PUT",
    headers: json(token),
    body: JSON.stringify({ role }),
  });
}
function add(f: Fixture, group: string) {
  return patchScim(f.app, groupsPath(f.org.id, group), f.token, [
    { op: "add", path: "members", value: [{ value: f.userId }] },
  ]);
}
async function snapshot(f: Fixture, group: string) {
  return structuredClone({
    group: await f.ctx.stores.scim.groups.getById(f.org.id, group),
    user: await f.ctx.stores.scim.users.getById(f.org.id, f.userId),
    membership: await f.ctx.stores.organizationMemberships.find(
      f.org.id,
      f.member.principalId,
    ),
    mappings: await f.ctx.stores.scim.mappings.listByOrganization(f.org.id),
    audit: await f.ctx.repos.auditEvents.list({ limit: 200 }),
  });
}
async function populatedMapping() {
  const f = await tenantFixture();
  expect((await add(f, "operators")).status).toBe(200);
  expect(
    await provisionedRoleForSubject(f.ctx, f.org.id, f.subject),
  ).toBeUndefined();
  expect((await mapping(f, "operators", "admin")).status).toBe(200);
  expect(
    (
      await f.ctx.stores.organizationMemberships.find(
        f.org.id,
        f.member.principalId,
      )
    )?.role,
  ).toBe("admin");
  expect((await mapping(f, "operators", "member")).status).toBe(200);
  expect(
    (
      await f.ctx.stores.organizationMemberships.find(
        f.org.id,
        f.member.principalId,
      )
    )?.role,
  ).toBe("member");
  expect((await add(f, "auditors")).status).toBe(200);
  expect((await mapping(f, "auditors", "admin")).status).toBe(200);
  expect((await mapping(f, "operators", "member")).status).toBe(200);
  expect(await provisionedRoleForSubject(f.ctx, f.org.id, f.subject)).toBe(
    "admin",
  );
  expect(
    (
      await f.ctx.stores.organizationMemberships.find(
        f.org.id,
        f.member.principalId,
      )
    )?.role,
  ).toBe("admin");
}
async function rejectedBatch() {
  const f = await tenantFixture();
  expect((await mapping(f, "operators", "admin")).status).toBe(200);
  expect((await add(f, "operators")).status).toBe(200);
  const before = await snapshot(f, "operators");
  for (const invalid of [
    { op: "replace", path: "members", value: [{ value: f.userId }] },
    { op: "remove", path: 'members[display eq "member"]' },
  ]) {
    const response = await patchScim(
      f.app,
      groupsPath(f.org.id, "operators"),
      f.token,
      [{ op: "remove", path: `members[value eq "${f.userId}"]` }, invalid],
    );
    expect(response.status).toBe(400);
    expect(await snapshot(f, "operators")).toEqual(before);
  }
  const removed = await patchScim(
    f.app,
    groupsPath(f.org.id, "operators"),
    f.token,
    [{ op: "remove", path: `members[value eq "${f.userId}"]` }],
  );
  expect(removed.status).toBe(200);
  expect(
    (await f.ctx.stores.scim.groups.getById(f.org.id, "operators"))?.memberIds,
  ).toEqual([]);
  expect(
    (
      await f.ctx.stores.organizationMemberships.find(
        f.org.id,
        f.member.principalId,
      )
    )?.role,
  ).toBe("member");
}
async function renameDoesNotGrant() {
  const f = await tenantFixture();
  expect((await add(f, "unmapped")).status).toBe(200);
  const before = await snapshot(f, "unmapped");
  const response = await patchScim(
    f.app,
    groupsPath(f.org.id, "unmapped"),
    f.token,
    [{ op: "replace", path: "displayName", value: "  Owners  " }],
  );
  expect(response.status).toBe(200);
  expect(overlapCast(await response.json()).displayName).toBe("Owners");
  const after = await snapshot(f, "unmapped");
  expect(after.group?.memberIds).toEqual(before.group?.memberIds);
  expect(after.group?.createdAt).toEqual(before.group?.createdAt);
  expect(after.user).toEqual(before.user);
  expect(after.membership).toEqual(before.membership);
  expect(
    await provisionedRoleForSubject(f.ctx, f.org.id, f.subject),
  ).toBeUndefined();
}
async function ownerMappingFence() {
  const f = await tenantFixture();
  expect((await add(f, "operators")).status).toBe(200);
  const outsider = await provisional(f.app);
  const before = await snapshot(f, "operators");
  expect(
    (await mapping(f, "operators", "owner", outsider.accessToken)).status,
  ).toBe(404);
  expect(
    (await mapping(f, "operators", "owner", f.member.accessToken)).status,
  ).toBe(403);
  expect((await mapping(f, "operators", "root")).status).toBe(400);
  const malformed = await f.app.request(
    `/v1/organizations/${f.org.id}/scim/mappings/operators`,
    {
      method: "PUT",
      headers: json(f.owner.accessToken),
      body: "{",
    },
  );
  expect(malformed.status).toBe(400);
  expect(await snapshot(f, "operators")).toEqual(before);
  expect((await mapping(f, "operators", "admin")).status).toBe(200);
  expect(
    (
      await f.ctx.stores.organizationMemberships.find(
        f.org.id,
        f.member.principalId,
      )
    )?.role,
  ).toBe("admin");
}

describe("SCIM public mapping and atomic group effects", () => {
  it(
    "remaps an already populated group and retains the strongest remaining mapped role",
    populatedMapping,
  );
  it(
    "rejects a later invalid operation without committing an earlier membership removal",
    rejectedBatch,
  );
  it(
    "renames an unmapped populated group without inferring privilege from its new label",
    renameDoesNotGrant,
  );
  it(
    "keeps mapping authority with the owner and preserves all state on foreign, member and malformed requests",
    ownerMappingFence,
  );
});
