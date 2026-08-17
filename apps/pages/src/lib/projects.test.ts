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

afterEach(() => {
  kvDelete(PROJECTS_KEY);
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

  it("recovers from a corrupt registry and a vanished active project", () => {
    kvSet(PROJECTS_KEY, "not-json");
    rehydrateProjects();
    expect(activeProject().id).toBe(PERSONAL_PROJECT_ID);

    kvSet(
      PROJECTS_KEY,
      JSON.stringify({ v: 1, projects: [], activeId: "prj_gone" }),
    );
    rehydrateProjects();
    expect(activeProject().id).toBe(PERSONAL_PROJECT_ID);
    expect(listProjects()).toHaveLength(1);
  });

  it("lists every per-project key for hydration and deletion", async () => {
    const project = await createProject("Work");
    const keys = projectScopedKeys(project.id);
    expect(keys).toContain(`project.${project.id}.vault.header.v1`);
    expect(keys).toContain(`project.${project.id}.site-broker.consents.v1`);
    expect(projectScopedKeys(PERSONAL_PROJECT_ID)).toContain("vault.header.v1");
  });
});
