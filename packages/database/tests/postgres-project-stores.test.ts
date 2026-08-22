import { PERSONAL_PROJECT_SLUG } from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PERSONAL_PROJECT_TOMB_NAME,
  type ProjectStores,
} from "../src/repos/interfaces.js";
import { createPostgresProjectStores } from "../src/repos/postgres.js";
import { makePrincipal, makeProject } from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

let ctx: PgTestContext;
let stores: ProjectStores;

async function principal(): Promise<string> {
  const row = await ctx.repos.principals.create(makePrincipal());
  return row.id;
}

beforeAll(async () => {
  ctx = await createPgTestContext();
  stores = createPostgresProjectStores(ctx.db);
}, 60_000);

afterAll(async () => {
  await ctx.client.close();
});

describe("PostgresProjectStore", () => {
  it("set upserts a full row and get maps optionals faithfully", async () => {
    const owner = await principal();
    const project = makeProject({
      ownerPrincipalId: owner,
      sealedStoreTombName: "work",
      pagesVaultFolderId: "vault_folder_abc",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await stores.projects.set(project.id, project);
    expect(await stores.projects.get(project.id)).toEqual(project);

    // Replace semantics: dropping an optional field nulls the column.
    const { sealedStoreTombName: _tomb, ...rest } = project;
    const next = { ...rest, displayName: "Renamed", updatedAt: new Date() };
    await stores.projects.set(project.id, next);
    const read = await stores.projects.get(project.id);
    expect(read?.displayName).toBe("Renamed");
    expect(read?.sealedStoreTombName).toBeUndefined();
  });

  it("returns undefined for an unknown id", async () => {
    expect(await stores.projects.get("prj_missing")).toBeUndefined();
  });

  it("lists projects by owner across kinds and states", async () => {
    const owner = await principal();
    const other = await principal();
    const active = makeProject({ ownerPrincipalId: owner });
    const deleted = makeProject({ ownerPrincipalId: owner, state: "deleted" });
    const foreign = makeProject({ ownerPrincipalId: other });
    for (const p of [active, deleted, foreign]) {
      await stores.projects.set(p.id, p);
    }
    const owned = await stores.projects.listByOwner(owner);
    expect(owned.map((p) => p.id).sort()).toEqual(
      [active.id, deleted.id].sort(),
    );
  });

  it("ensurePersonal is a single upsert honoring projects_personal_owner_uidx", async () => {
    const owner = await principal();
    const now = new Date("2026-08-08T10:00:00Z");

    const first = await stores.projects.ensurePersonal(owner, undefined, now);
    expect(first.created).toBe(true);
    expect(first.project.kind).toBe("personal");
    expect(first.project.slug).toBe(PERSONAL_PROJECT_SLUG);
    expect(first.project.sealedStoreTombName).toBe(PERSONAL_PROJECT_TOMB_NAME);

    // Owner membership is minted with the project.
    const membership = await stores.projectMemberships.find(
      first.project.id,
      owner,
    );
    expect(membership?.role).toBe("owner");

    // Second call converges on the existing row without a second insert.
    const second = await stores.projects.ensurePersonal(owner);
    expect(second.created).toBe(false);
    expect(second.project.id).toBe(first.project.id);

    // The partial index constrains personal projects only: a standard project
    // for the same owner still inserts fine.
    const standard = makeProject({ ownerPrincipalId: owner });
    await stores.projects.set(standard.id, standard);
    expect((await stores.projects.listByOwner(owner)).length).toBe(2);
  });

  it("ensurePersonal converges when two sessions race", async () => {
    const owner = await principal();
    const [a, b] = await Promise.all([
      stores.projects.ensurePersonal(owner),
      stores.projects.ensurePersonal(owner),
    ]);
    expect(a.project.id).toBe(b.project.id);
    expect([a.created, b.created].filter(Boolean).length).toBe(1);
  });

  it("findPersonalByOwner returns only the live personal project", async () => {
    const owner = await principal();
    expect(await stores.projects.findPersonalByOwner(owner)).toBeUndefined();
    const { project } = await stores.projects.ensurePersonal(owner);
    expect((await stores.projects.findPersonalByOwner(owner))?.id).toBe(
      project.id,
    );
  });
});

describe("PostgresProjectMembershipStore", () => {
  it("upserts, finds, lists, counts and removes", async () => {
    const owner = await principal();
    const member = await principal();
    const project = makeProject({ ownerPrincipalId: owner });
    await stores.projects.set(project.id, project);
    const now = new Date();

    await stores.projectMemberships.upsert({
      projectId: project.id,
      principalId: owner,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    });
    await stores.projectMemberships.upsert({
      projectId: project.id,
      principalId: member,
      role: "member",
      createdAt: now,
      updatedAt: now,
    });

    expect(
      (await stores.projectMemberships.find(project.id, member))?.role,
    ).toBe("member");
    expect(
      await stores.projectMemberships.listByProject(project.id),
    ).toHaveLength(2);
    expect(await stores.projectMemberships.listByPrincipal(owner)).toHaveLength(
      1,
    );
    expect(await stores.projectMemberships.countOwners(project.id)).toBe(1);

    // Role change goes through the same upsert.
    await stores.projectMemberships.upsert({
      projectId: project.id,
      principalId: member,
      role: "admin",
      createdAt: now,
      updatedAt: new Date(),
    });
    expect(
      (await stores.projectMemberships.find(project.id, member))?.role,
    ).toBe("admin");
    expect(
      await stores.projectMemberships.listByProject(project.id),
    ).toHaveLength(2);

    expect(await stores.projectMemberships.remove(project.id, member)).toBe(
      true,
    );
    expect(await stores.projectMemberships.remove(project.id, member)).toBe(
      false,
    );
    expect(await stores.projectMemberships.removeByProject(project.id)).toBe(1);
    expect(await stores.projectMemberships.listByProject(project.id)).toEqual(
      [],
    );
  });
});
