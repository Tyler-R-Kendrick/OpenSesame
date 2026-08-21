import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { type JsonObject, overlapCast, type BoundaryValue } from "@opensesame/os-domain";

type App = ReturnType<typeof createControlPlane>["app"];

function testConfig() {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
  } as const;
}

async function provisional(app: App) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

async function verified(app: App, subject: string) {
  const created = await provisional(app);
  const linked = await app.request("/v1/principals/link-identities", {
    method: "POST",
    headers: {
      authorization: `Bearer ${created.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      kind: "oidc",
      issuer: "https://mock.example",
      subject,
      assurance: "verified",
    }),
  });
  expect(linked.status).toBe(201);
  return created;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function createProject(
  app: App,
  token: string,
  body: JsonObject,
) {
  return app.request("/v1/projects", {
    method: "POST",
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function addMember(
  app: App,
  token: string,
  projectId: string,
  principalId: string,
  role: string,
) {
  return app.request(`/v1/projects/${projectId}/members`, {
    method: "POST",
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify({ principalId, role }),
  });
}

describe("projects routes edge cases", () => {
  it("creates standard projects, orders them, and rejects bad input", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "proj-owner");

    expect((await createProject(app, owner.accessToken, {})).status).toBe(400);

    const alpha = await createProject(app, owner.accessToken, {
      displayName: "Alpha",
    });
    expect(alpha.status).toBe(201);
    const beta = await createProject(app, owner.accessToken, {
      displayName: "Beta",
      sealedStoreTombName: "tomb-beta",
      pagesVaultFolderId: "vault_folder_beta",
    });
    expect(beta.status).toBe(201);
    const betaBody = overlapCast(await beta.json());
    expect(betaBody.sealedStoreTombName).toBe("tomb-beta");
    expect(betaBody.pagesVaultFolderId).toBe("vault_folder_beta");

    // Personal first, then newest first.
    const list = await app.request("/v1/projects", {
      headers: auth(owner.accessToken),
    });
    const projects = (
      overlapCast(await list.json())
    ).projects;
    expect(projects.map((p) => p.slug)).toEqual(["personal", "beta", "alpha"]);

    // The reserved slug and collisions are refused.
    const reserved = await createProject(app, owner.accessToken, {
      displayName: "Mine",
      slug: "personal",
    });
    expect(reserved.status).toBe(400);

    const dupe = await createProject(app, owner.accessToken, {
      displayName: "Alpha again",
      slug: "alpha",
    });
    expect(dupe.status).toBe(409);
    expect((overlapCast(await dupe.json())).error).toBe("slug_taken");

    // A name with no sluggable characters gets a generated slug.
    const symbols = await createProject(app, owner.accessToken, {
      displayName: "!!!",
    });
    expect(symbols.status).toBe(201);
    expect((overlapCast(await symbols.json())).slug).toMatch(
      /^project-[0-9a-f]{8}$/,
    );
  });

  it("scopes standard projects to organizations the caller belongs to", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "org-proj-owner");

    const unknownOrg = await createProject(app, owner.accessToken, {
      displayName: "Orphan",
      organizationId: "org:missing",
    });
    expect(unknownOrg.status).toBe(404);
    expect((overlapCast(await unknownOrg.json())).error).toBe(
      "organization_not_found",
    );

    const orgRes = await app.request("/v1/organizations", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ slug: "proj-org", displayName: "Proj Org" }),
    });
    expect(orgRes.status).toBe(201);
    const org = overlapCast(await orgRes.json());

    const inOrg = await createProject(app, owner.accessToken, {
      displayName: "Grouped",
      organizationId: org.id,
    });
    expect(inOrg.status).toBe(201);
    expect(
      (overlapCast(await inOrg.json())).organizationId,
    ).toBe(org.id);
  });

  it("lets provisional principals create a standard project", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const anon = await provisional(app);
    const res = await createProject(app, anon.accessToken, {
      displayName: "Guest Work",
    });
    expect(res.status).toBe(201);
    expect(overlapCast(await res.json())).toMatchObject({
      displayName: "Guest Work",
      kind: "standard",
    });
  });

  it("tracks the active project and drops stale selections", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "active-owner");

    const initial = await app.request("/v1/projects/active", {
      headers: auth(owner.accessToken),
    });
    expect(initial.status).toBe(200);
    const initialBody = overlapCast(await initial.json());
    expect(initialBody.project.kind).toBe("personal");
    expect(initialBody.isFallback).toBe(true);

    expect(
      (
        await app.request("/v1/projects/active", {
          method: "PUT",
          headers: {
            ...auth(owner.accessToken),
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await app.request("/v1/projects/active", {
          method: "PUT",
          headers: {
            ...auth(owner.accessToken),
            "content-type": "application/json",
          },
          body: JSON.stringify({ projectId: "prj_missing" }),
        })
      ).status,
    ).toBe(404);

    const created = await createProject(app, owner.accessToken, {
      displayName: "Swap Target",
    });
    const project = overlapCast(await created.json());
    const swapped = await app.request("/v1/projects/active", {
      method: "PUT",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ projectId: project.id }),
    });
    expect(swapped.status).toBe(200);
    expect((overlapCast(await swapped.json())).isFallback).toBe(
      false,
    );

    // A selection pointing at a vanished project falls back to personal.
    ctx.stores.activeProjects.set(owner.principalId, "prj_gone");
    const fallback = await app.request("/v1/projects/active", {
      headers: auth(owner.accessToken),
    });
    const fallbackBody = overlapCast(await fallback.json());
    expect(fallbackBody.project.kind).toBe("personal");
    expect(fallbackBody.isFallback).toBe(true);
    expect(ctx.stores.activeProjects.has(owner.principalId)).toBe(false);
  });

  it("hides expired temporary projects from reads and lists", async () => {
    let now = new Date("2026-08-08T10:00:00Z");
    const { app } = createControlPlane({
      config: testConfig(),
      clock: () => now,
    });
    const owner = await provisional(app);

    const created = await app.request("/v1/projects/temporary", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Short", ttlSeconds: 60 }),
    });
    expect(created.status).toBe(201);
    const project = overlapCast(await created.json());

    // The owner sees their membership-less temporary project.
    const visible = await app.request(`/v1/projects/${project.projectId}`, {
      headers: auth(owner.accessToken),
    });
    expect(visible.status).toBe(200);
    expect((overlapCast(await visible.json())).role).toBe("owner");

    now = new Date(now.getTime() + 61_000);
    expect(
      (
        await app.request(`/v1/projects/${project.projectId}`, {
          headers: auth(owner.accessToken),
        })
      ).status,
    ).toBe(404);
    const list = await app.request("/v1/projects", {
      headers: auth(owner.accessToken),
    });
    const slugs = (
      overlapCast(await list.json())
    ).projects.map((p) => p.id);
    expect(slugs).not.toContain(project.projectId);
  });

  it("rejects reads of unknown or foreign projects", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "read-owner");
    const outsider = await verified(app, "read-outsider");

    const created = await createProject(app, owner.accessToken, {
      displayName: "Private",
    });
    const project = overlapCast(await created.json());

    expect(
      (
        await app.request("/v1/projects/prj_missing", {
          headers: auth(owner.accessToken),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/v1/projects/${project.id}`, {
          headers: auth(outsider.accessToken),
        })
      ).status,
    ).toBe(404);
  });

  it("patches display name and vault metadata with validation", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "patch-owner");
    const created = await createProject(app, owner.accessToken, {
      displayName: "Patch Me",
      sealedStoreTombName: "tomb-1",
      pagesVaultFolderId: "folder-1",
    });
    const project = overlapCast(await created.json());
    const patch = (body: JsonObject) =>
      app.request(`/v1/projects/${project.id}`, {
        method: "PATCH",
        headers: {
          ...auth(owner.accessToken),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

    expect((await patch({ displayName: "   " })).status).toBe(400);
    expect((await patch({ displayName: "x".repeat(129) })).status).toBe(400);
    expect((await patch({ sealedStoreTombName: "bad..tomb" })).status).toBe(
      400,
    );
    expect((await patch({ sealedStoreTombName: "bad tomb!" })).status).toBe(
      400,
    );
    expect((await patch({ pagesVaultFolderId: "bad..folder" })).status).toBe(
      400,
    );

    const renamed = await patch({ displayName: "Renamed" });
    expect(renamed.status).toBe(200);
    expect(
      (overlapCast(await renamed.json())).displayName,
    ).toBe("Renamed");

    const updated = await patch({
      sealedStoreTombName: "tomb-2",
      pagesVaultFolderId: "folder-2",
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      sealedStoreTombName: "tomb-2",
      pagesVaultFolderId: "folder-2",
    });

    // Null clears the binding metadata.
    const cleared = await patch({
      sealedStoreTombName: null,
      pagesVaultFolderId: null,
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      sealedStoreTombName: null,
      pagesVaultFolderId: null,
    });

    // Unknown projects cannot be patched.
    expect(
      (
        await app.request("/v1/projects/prj_missing", {
          method: "PATCH",
          headers: {
            ...auth(owner.accessToken),
            "content-type": "application/json",
          },
          body: JSON.stringify({ displayName: "x" }),
        })
      ).status,
    ).toBe(404);
  });

  it("restricts patching and deletion to admins and owners", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "del-owner");
    const member = await provisional(app);

    const created = await createProject(app, owner.accessToken, {
      displayName: "Guarded",
    });
    const project = overlapCast(await created.json());
    expect(
      (
        await addMember(
          app,
          owner.accessToken,
          project.id,
          member.principalId,
          "member",
        )
      ).status,
    ).toBe(201);

    const memberPatch = await app.request(`/v1/projects/${project.id}`, {
      method: "PATCH",
      headers: {
        ...auth(member.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ displayName: "Hijack" }),
    });
    expect(memberPatch.status).toBe(403);
    expect((overlapCast(await memberPatch.json())).error).toBe(
      "admin_required",
    );

    const memberDelete = await app.request(`/v1/projects/${project.id}`, {
      method: "DELETE",
      headers: auth(member.accessToken),
    });
    expect(memberDelete.status).toBe(403);
    expect((overlapCast(await memberDelete.json())).error).toBe(
      "owner_required",
    );

    // The personal project can never be deleted.
    const active = await app.request("/v1/projects/active", {
      headers: auth(owner.accessToken),
    });
    const personal = (overlapCast(await active.json()))
      .project;
    const personalDelete = await app.request(`/v1/projects/${personal.id}`, {
      method: "DELETE",
      headers: auth(owner.accessToken),
    });
    expect(personalDelete.status).toBe(409);
    expect((overlapCast(await personalDelete.json())).error).toBe(
      "personal_project_immutable",
    );

    const deleted = await app.request(`/v1/projects/${project.id}`, {
      method: "DELETE",
      headers: auth(owner.accessToken),
    });
    expect(deleted.status).toBe(204);
    expect(
      (
        await app.request(`/v1/projects/${project.id}`, {
          headers: auth(owner.accessToken),
        })
      ).status,
    ).toBe(404);
    // The member's dangling membership went with it.
    expect(
      (
        await app.request(`/v1/projects/${project.id}/members`, {
          headers: auth(member.accessToken),
        })
      ).status,
    ).toBe(404);
  });

  it("manages members with role fences", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "member-owner");
    const admin = await provisional(app);
    const member = await provisional(app);
    const suspended = await provisional(app);

    const created = await createProject(app, owner.accessToken, {
      displayName: "Team",
    });
    const project = overlapCast(await created.json());

    // Unknown project.
    expect(
      (
        await addMember(
          app,
          owner.accessToken,
          "prj_missing",
          member.principalId,
          "member",
        )
      ).status,
    ).toBe(404);

    // The personal project is not shareable.
    const active = await app.request("/v1/projects/active", {
      headers: auth(owner.accessToken),
    });
    const personal = (overlapCast(await active.json()))
      .project;
    const sharePersonal = await addMember(
      app,
      owner.accessToken,
      personal.id,
      member.principalId,
      "member",
    );
    expect(sharePersonal.status).toBe(409);
    expect((overlapCast(await sharePersonal.json())).error).toBe(
      "personal_project_not_shareable",
    );

    // Validation, unknown principals, suspended principals.
    expect(
      (
        await app.request(`/v1/projects/${project.id}/members`, {
          method: "POST",
          headers: {
            ...auth(owner.accessToken),
            "content-type": "application/json",
          },
          body: JSON.stringify({ principalId: member.principalId }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await addMember(
          app,
          owner.accessToken,
          project.id,
          "prn_missing",
          "member",
        )
      ).status,
    ).toBe(404);

    const suspendedRecord = await ctx.repos.principals.getById(
      suspended.principalId,
    );
    if (!suspendedRecord) throw new Error("principal missing");
    await ctx.repos.principals.update(
      suspended.principalId,
      { state: "suspended" },
      suspendedRecord.version,
    );
    const inactive = await addMember(
      app,
      owner.accessToken,
      project.id,
      suspended.principalId,
      "member",
    );
    expect(inactive.status).toBe(409);
    expect((overlapCast(await inactive.json())).error).toBe(
      "principal_inactive",
    );

    // Members and an admin.
    expect(
      (
        await addMember(
          app,
          owner.accessToken,
          project.id,
          member.principalId,
          "member",
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await addMember(
          app,
          owner.accessToken,
          project.id,
          admin.principalId,
          "admin",
        )
      ).status,
    ).toBe(201);
    const dupe = await addMember(
      app,
      owner.accessToken,
      project.id,
      member.principalId,
      "member",
    );
    expect(dupe.status).toBe(409);
    expect((overlapCast(await dupe.json())).error).toBe(
      "membership_exists",
    );

    // Only an owner mints another owner.
    const ownerByAdmin = await addMember(
      app,
      admin.accessToken,
      project.id,
      suspended.principalId,
      "owner",
    );
    expect(ownerByAdmin.status).toBe(403);
    expect((overlapCast(await ownerByAdmin.json())).error).toBe(
      "owner_required",
    );

    // Members cannot add anyone.
    const memberAdds = await addMember(
      app,
      member.accessToken,
      project.id,
      suspended.principalId,
      "member",
    );
    expect(memberAdds.status).toBe(403);

    // Listing: members are fenced out, admins and owners are not.
    expect(
      (
        await app.request(`/v1/projects/${project.id}/members`, {
          headers: auth(member.accessToken),
        })
      ).status,
    ).toBe(403);
    const list = await app.request(`/v1/projects/${project.id}/members`, {
      headers: auth(owner.accessToken),
    });
    expect(list.status).toBe(200);
    expect(
      (overlapCast(await list.json())).members,
    ).toHaveLength(3);
  });

  it("changes member roles with owner and last-owner fences", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "role-owner");
    const admin = await provisional(app);
    const member = await provisional(app);

    const created = await createProject(app, owner.accessToken, {
      displayName: "Roles",
    });
    const project = overlapCast(await created.json());
    await addMember(
      app,
      owner.accessToken,
      project.id,
      admin.principalId,
      "admin",
    );
    await addMember(
      app,
      owner.accessToken,
      project.id,
      member.principalId,
      "member",
    );

    const changeRole = (token: string, target: string, body: BoundaryValue) =>
      app.request(`/v1/projects/${project.id}/members/${target}`, {
        method: "PATCH",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // Unknown project and unknown membership.
    expect(
      (
        await app.request(
          `/v1/projects/prj_missing/members/${member.principalId}`,
          {
            method: "PATCH",
            headers: {
              ...auth(owner.accessToken),
              "content-type": "application/json",
            },
            body: JSON.stringify({ role: "admin" }),
          },
        )
      ).status,
    ).toBe(404);
    expect(
      (await changeRole(owner.accessToken, "prn_missing", { role: "admin" }))
        .status,
    ).toBe(404);

    // Members cannot change roles at all.
    expect(
      (
        await changeRole(member.accessToken, admin.principalId, {
          role: "member",
        })
      ).status,
    ).toBe(403);

    // Validation.
    expect(
      (await changeRole(owner.accessToken, member.principalId, {})).status,
    ).toBe(400);

    // Admins cannot touch the owner role in either direction.
    expect(
      (
        await changeRole(admin.accessToken, member.principalId, {
          role: "owner",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await changeRole(admin.accessToken, owner.principalId, {
          role: "admin",
        })
      ).status,
    ).toBe(403);

    // A no-op change answers with the current membership.
    const noop = await changeRole(owner.accessToken, member.principalId, {
      role: "member",
    });
    expect(noop.status).toBe(200);
    expect((overlapCast(await noop.json())).role).toBe("member");

    // Admins may move members between non-owner roles.
    const promoted = await changeRole(admin.accessToken, member.principalId, {
      role: "admin",
    });
    expect(promoted.status).toBe(200);
    expect((overlapCast(await promoted.json())).role).toBe("admin");

    // The last owner cannot be demoted.
    const demote = await changeRole(owner.accessToken, owner.principalId, {
      role: "member",
    });
    expect(demote.status).toBe(409);
    expect((overlapCast(await demote.json())).error).toBe(
      "last_owner",
    );
  });

  it("removes members with self-leave, owner, and last-owner fences", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "remove-owner");
    const admin = await provisional(app);
    const member = await provisional(app);
    const leaver = await provisional(app);

    const created = await createProject(app, owner.accessToken, {
      displayName: "Remove",
    });
    const project = overlapCast(await created.json());
    await addMember(
      app,
      owner.accessToken,
      project.id,
      admin.principalId,
      "admin",
    );
    await addMember(
      app,
      owner.accessToken,
      project.id,
      member.principalId,
      "member",
    );
    await addMember(
      app,
      owner.accessToken,
      project.id,
      leaver.principalId,
      "member",
    );

    const remove = (token: string, target: string, projectId = project.id) =>
      app.request(`/v1/projects/${projectId}/members/${target}`, {
        method: "DELETE",
        headers: auth(token),
      });

    expect(
      (await remove(owner.accessToken, "prn_missing", "prj_missing")).status,
    ).toBe(404);
    expect((await remove(owner.accessToken, "prn_missing")).status).toBe(404);

    // A member may leave but may not remove others.
    expect((await remove(member.accessToken, leaver.principalId)).status).toBe(
      403,
    );

    // Swapping to a project then losing membership clears the selection.
    await app.request("/v1/projects/active", {
      method: "PUT",
      headers: {
        ...auth(leaver.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ projectId: project.id }),
    });
    expect(ctx.stores.activeProjects.get(leaver.principalId)).toBe(project.id);
    expect((await remove(leaver.accessToken, leaver.principalId)).status).toBe(
      204,
    );
    expect(ctx.stores.activeProjects.has(leaver.principalId)).toBe(false);

    // Admins cannot remove the owner.
    expect((await remove(admin.accessToken, owner.principalId)).status).toBe(
      403,
    );

    // The last owner cannot leave.
    const lastOwner = await remove(owner.accessToken, owner.principalId);
    expect(lastOwner.status).toBe(409);
    expect((overlapCast(await lastOwner.json())).error).toBe(
      "last_owner",
    );

    // Owner removes a member.
    expect((await remove(owner.accessToken, member.principalId)).status).toBe(
      204,
    );
  });

  it("refuses membership removal from the personal project", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "personal-remove-owner");
    const second = await provisional(app);

    const active = await app.request("/v1/projects/active", {
      headers: auth(owner.accessToken),
    });
    const personal = (
      overlapCast(await active.json())
    ).project;

    // Personal projects refuse sharing through the API, so seed a second owner
    // directly to get past the last-owner fence.
    const now = ctx.clock();
    ctx.stores.projectMemberships.set(`${personal.id}:${second.principalId}`, {
      projectId: personal.id,
      principalId: second.principalId,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.request(
      `/v1/projects/${personal.id}/members/${second.principalId}`,
      { method: "DELETE", headers: auth(owner.accessToken) },
    );
    expect(res.status).toBe(409);
    expect((overlapCast(await res.json())).error).toBe(
      "personal_project_immutable",
    );
  });
});
