import { randomUUID } from "node:crypto";
import { PERSONAL_PROJECT_SLUG } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  PERSONAL_PROJECT_TOMB_NAME,
  PERSONAL_VAULT_FOLDER_PREFIX,
} from "../src/repos/interfaces.js";
import { createMemoryProjectStores } from "../src/repos/memory.js";
import { makeProject } from "./factories.js";

describe("MemoryProjectStore", () => {
  it("upserts and reads back full rows via Map set/get", async () => {
    const { projects } = createMemoryProjectStores();
    const project = makeProject({ ownerPrincipalId: "prn_a" });
    await projects.set(project.id, project);
    expect(await projects.get(project.id)).toEqual(project);

    const renamed = { ...project, displayName: "Renamed" };
    await projects.set(project.id, renamed);
    expect((await projects.get(project.id))?.displayName).toBe("Renamed");
  });

  it("lists projects by owner regardless of kind or state", async () => {
    const { projects } = createMemoryProjectStores();
    const mine = makeProject({ ownerPrincipalId: "prn_owner" });
    const deleted = makeProject({
      ownerPrincipalId: "prn_owner",
      state: "deleted",
    });
    const theirs = makeProject({ ownerPrincipalId: "prn_other" });
    for (const p of [mine, deleted, theirs]) {
      await projects.set(p.id, p);
    }
    const owned = await projects.listByOwner("prn_owner");
    expect(owned.map((p) => p.id).sort()).toEqual([mine.id, deleted.id].sort());
  });

  it("finds the live personal project and skips deleted/deleting rows", async () => {
    const { projects } = createMemoryProjectStores();
    const dead = makeProject({
      kind: "personal",
      ownerPrincipalId: "prn_p",
      state: "deleted",
      slug: PERSONAL_PROJECT_SLUG,
    });
    await projects.set(dead.id, dead);
    expect(await projects.findPersonalByOwner("prn_p")).toBeUndefined();

    const live = makeProject({
      kind: "personal",
      ownerPrincipalId: "prn_p",
      slug: PERSONAL_PROJECT_SLUG,
    });
    await projects.set(live.id, live);
    expect((await projects.findPersonalByOwner("prn_p"))?.id).toBe(live.id);
  });

  it("ensurePersonal creates once with tomb/vault bindings and owner membership", async () => {
    const { projects, projectMemberships } = createMemoryProjectStores();
    const now = new Date("2026-08-08T10:00:00Z");

    const first = await projects.ensurePersonal("prn_e", undefined, now);
    expect(first.created).toBe(true);
    expect(first.project.kind).toBe("personal");
    expect(first.project.slug).toBe(PERSONAL_PROJECT_SLUG);
    expect(first.project.state).toBe("active");
    expect(first.project.sealedStoreTombName).toBe(PERSONAL_PROJECT_TOMB_NAME);
    expect(first.project.pagesVaultFolderId).toMatch(
      new RegExp(`^${PERSONAL_VAULT_FOLDER_PREFIX}`),
    );
    expect(first.project.createdAt).toEqual(now);
    expect(first.project.organizationId).toBeUndefined();

    const membership = await projectMemberships.find(first.project.id, "prn_e");
    expect(membership?.role).toBe("owner");

    const second = await projects.ensurePersonal("prn_e", undefined, now);
    expect(second.created).toBe(false);
    expect(second.project.id).toBe(first.project.id);
  });

  it("ensurePersonal records the organization when given one", async () => {
    const { projects } = createMemoryProjectStores();
    const orgId = `org:${randomUUID()}`;
    const { project, created } = await projects.ensurePersonal("prn_o", orgId);
    expect(created).toBe(true);
    expect(project.organizationId).toBe(orgId);
  });
});

describe("MemoryProjectMembershipStore", () => {
  it("upserts, finds, lists and removes by structured keys", async () => {
    const { projectMemberships } = createMemoryProjectStores();
    const now = new Date();
    await projectMemberships.upsert({
      projectId: "prj_1",
      principalId: "prn_a",
      role: "owner",
      createdAt: now,
      updatedAt: now,
    });
    await projectMemberships.upsert({
      projectId: "prj_1",
      principalId: "prn_b",
      role: "member",
      createdAt: now,
      updatedAt: now,
    });
    await projectMemberships.upsert({
      projectId: "prj_2",
      principalId: "prn_a",
      role: "admin",
      createdAt: now,
      updatedAt: now,
    });

    expect((await projectMemberships.find("prj_1", "prn_b"))?.role).toBe(
      "member",
    );
    expect(await projectMemberships.find("prj_1", "prn_c")).toBeUndefined();
    expect(await projectMemberships.listByProject("prj_1")).toHaveLength(2);
    expect(await projectMemberships.listByPrincipal("prn_a")).toHaveLength(2);
    expect(await projectMemberships.countOwners("prj_1")).toBe(1);
    expect(await projectMemberships.countOwners("prj_2")).toBe(0);

    expect(await projectMemberships.remove("prj_1", "prn_b")).toBe(true);
    expect(await projectMemberships.remove("prj_1", "prn_b")).toBe(false);
    expect(await projectMemberships.removeByProject("prj_1")).toBe(1);
    expect(await projectMemberships.listByProject("prj_1")).toEqual([]);
  });

  it("upsert replaces the role for an existing (project, principal) pair", async () => {
    const { projectMemberships } = createMemoryProjectStores();
    const now = new Date();
    await projectMemberships.upsert({
      projectId: "prj_r",
      principalId: "prn_r",
      role: "member",
      createdAt: now,
      updatedAt: now,
    });
    await projectMemberships.upsert({
      projectId: "prj_r",
      principalId: "prn_r",
      role: "admin",
      createdAt: now,
      updatedAt: now,
    });
    expect(await projectMemberships.listByProject("prj_r")).toHaveLength(1);
    expect((await projectMemberships.find("prj_r", "prn_r"))?.role).toBe(
      "admin",
    );
  });

  it("shares state with direct Map seeding (control-plane test compatibility)", async () => {
    const { projects, projectMemberships } = createMemoryProjectStores();
    const project = makeProject({ ownerPrincipalId: "prn_seed" });
    const now = new Date();
    // Existing control-plane tests seed via the Map API; the interface reads
    // must observe those rows.
    projects.set(project.id, project);
    projectMemberships.set(`${project.id}:prn_seed`, {
      projectId: project.id,
      principalId: "prn_seed",
      role: "owner",
      createdAt: now,
      updatedAt: now,
    });
    expect(projects.size).toBe(1);
    expect((await projectMemberships.find(project.id, "prn_seed"))?.role).toBe(
      "owner",
    );
    expect(await projectMemberships.countOwners(project.id)).toBe(1);
  });
});
