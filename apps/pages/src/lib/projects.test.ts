import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it } from "vitest";
import { kvDelete, kvGet, kvSet } from "./kv.js";
import {
  PERSONAL_PROJECT_ID,
  PROJECTS_KEY,
  activeProject,
  createProject,
  deleteProject,
  listProjects,
  projectScopedKeys,
  projectsState,
  rehydrateProjects,
  renameProject,
  scopedKey,
  setActiveProject,
} from "./projects.js";
import { TOMBS_REGISTRY_KEY, lockAllTombs, vfsFlush } from "./vfs.js";

afterEach(async () => {
  await vfsFlush();
  lockAllTombs();
  kvDelete(PROJECTS_KEY);
  kvDelete(TOMBS_REGISTRY_KEY);
  rehydrateProjects();
});

describe("project registry", () => {
  it("starts with the personal project active", () => {
    const state = projectsState();
    expect(state.projects.map((project) => project.id)).toEqual([
      PERSONAL_PROJECT_ID,
    ]);
    expect(state.activeId).toBe(PERSONAL_PROJECT_ID);
    expect(activeProject().kind).toBe("personal");
  });

  it("keeps legacy keys for the personal project and namespaces the rest", () => {
    expect(scopedKey("vault.header.v1", PERSONAL_PROJECT_ID)).toBe(
      "vault.header.v1",
    );
    expect(scopedKey("vault.header.v1", "prj_x")).toBe(
      "project.prj_x.vault.header.v1",
    );
  });

  it("creates, swaps to, and deletes a project with its sealed keys", async () => {
    const project = await createProject("Work");
    expect(listProjects().map((entry) => entry.name)).toEqual([
      "Personal",
      "Work",
    ]);

    await setActiveProject(project.id);
    expect(activeProject().id).toBe(project.id);
    expect(scopedKey("vault.body.v1")).toBe(
      `project.${project.id}.vault.body.v1`,
    );

    // Seed a sealed blob under the project scope, then delete the project.
    kvSet(scopedKey("vault.body.v1", project.id), "sealed");
    await deleteProject(project.id);
    expect(kvGet(`project.${project.id}.vault.body.v1`)).toBeNull();
    // Deleting the active project falls back to personal.
    expect(activeProject().id).toBe(PERSONAL_PROJECT_ID);
  });

  it("refuses duplicate names, empty names, and personal mutations", async () => {
    await createProject("Work");
    await expect(createProject("work")).rejects.toThrow(/already exists/);
    await expect(createProject("   ")).rejects.toThrow(/name/);
    await expect(deleteProject(PERSONAL_PROJECT_ID)).rejects.toThrow(
      /cannot be deleted/,
    );
    await expect(renameProject(PERSONAL_PROJECT_ID, "Mine")).rejects.toThrow(
      /cannot be renamed/,
    );
  });

  it("renames a standard project", async () => {
    const project = await createProject("Work");
    await renameProject(project.id, "Client A");
    expect(listProjects().find((entry) => entry.id === project.id)?.name).toBe(
      "Client A",
    );
  });

  it("recovers from a corrupt boot record and trusts a live pointer", () => {
    kvSet(PROJECTS_KEY, "not-json");
    rehydrateProjects();
    expect(activeProject().id).toBe(PERSONAL_PROJECT_ID);

    // The boot record is only a pointer now. A pointer naming a tomb with no
    // material is kept — a just-created project looks exactly like that until
    // its first header lands — and the tomb reads as an empty vault.
    kvSet(PROJECTS_KEY, JSON.stringify({ v: 1, activeId: "prj_gone" }));
    rehydrateProjects();
    expect(activeProject().id).toBe("prj_gone");
    expect(listProjects().map((project) => project.id)).toEqual([
      PERSONAL_PROJECT_ID,
      "prj_gone",
    ]);
  });

  it("lists every per-project key for hydration and deletion", async () => {
    const project = await createProject("Work");
    const keys = projectScopedKeys(project.id);
    expect(keys).toContain(`project.${project.id}.vault.header.v1`);
    expect(keys).toContain(`project.${project.id}.site-broker.consents.v1`);
    expect(projectScopedKeys(PERSONAL_PROJECT_ID)).toContain("vault.header.v1");
  });
});

describe("project registry sanitization", () => {
  it("falls back to defaults for non-object boot records", () => {
    kvSet(PROJECTS_KEY, JSON.stringify("just a string"));
    rehydrateProjects();
    expect(listProjects().map((p) => p.id)).toEqual([PERSONAL_PROJECT_ID]);
  });

  it("sanitizes a legacy full record as it seals into the tomb", async () => {
    // The full list lives sealed per tomb now; the repair rules run when the
    // legacy plaintext record migrates on unlock.
    const { mintVaultKey } = await import("./vault/crypto.js");
    const { unlockTomb } = await import("./vfs.js");
    const { migrateProjectsToVfs } = await import("./projects.js");
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_PROJECT_ID, vaultKey);

    kvSet(
      PROJECTS_KEY,
      JSON.stringify({
        v: 1,
        activeId: "prj_b",
        projects: [
          null,
          "junk",
          { id: 42, name: "no" },
          { id: "prj_a", name: "Alpha" },
          { id: PERSONAL_PROJECT_ID, name: "Forged Personal" },
          { id: "prj_b", name: "Beta", createdAt: "2026-01-01T00:00:00Z" },
        ],
      }),
    );
    await migrateProjectsToVfs(PERSONAL_PROJECT_ID);
    const state = projectsState();
    // The personal project always exists exactly once, and first.
    expect(state.projects.map((p) => p.id)).toEqual([
      PERSONAL_PROJECT_ID,
      "prj_a",
      "prj_b",
    ]);
    // Malformed entries get repaired rather than trusted.
    expect(state.projects[1]).toMatchObject({
      kind: "standard",
      createdAt: new Date(0).toISOString(),
    });
    expect(state.activeId).toBe("prj_b");
    // The plaintext key shrank to the boot pointer.
    const boot = overlapCast<{ activeId?: string; projects?: unknown }>(
      JSON.parse(kvGet(PROJECTS_KEY) ?? "{}"),
    );
    expect(boot.activeId).toBe("prj_b");
    expect(boot.projects).toBeUndefined();
  });

  it("notifies subscribers on rehydration and unsubscribes cleanly", async () => {
    const { subscribeProjects } = await import("./projects.js");
    let calls = 0;
    const unsubscribe = subscribeProjects(() => {
      calls += 1;
    });
    rehydrateProjects();
    expect(calls).toBe(1);
    unsubscribe();
    rehydrateProjects();
    expect(calls).toBe(1);
  });

  it("refuses an empty rename and unknown or no-op swaps", async () => {
    const project = await createProject("Work");
    await expect(renameProject(project.id, "  ")).rejects.toThrow(/name/);
    await expect(setActiveProject("prj_gone")).rejects.toThrow(
      /no longer exists/,
    );
    // Swapping to the already-active project is a no-op, not an error.
    await expect(
      setActiveProject(PERSONAL_PROJECT_ID),
    ).resolves.toBeUndefined();
    expect(activeProject().id).toBe(PERSONAL_PROJECT_ID);
  });

  it("ignores deletion of a project that is not there", async () => {
    await expect(deleteProject("prj_gone")).resolves.toBeUndefined();
    expect(listProjects().map((p) => p.id)).toEqual([PERSONAL_PROJECT_ID]);
  });
});
