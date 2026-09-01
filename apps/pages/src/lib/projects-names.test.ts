import { afterEach, describe, expect, it } from "vitest";
import { kvDelete } from "./kv.js";
import {
  PERSONAL_PROJECT_ID,
  PROJECTS_KEY,
  createProject,
  hydrateProjectsFromVfs,
  listProjects,
  rehydrateProjects,
  setActiveProject,
} from "./projects.js";
import { VaultStore } from "./vault/store.js";
import { lockAllTombs } from "./vfs.js";

const PASSWORD = "correct horse battery staple";

afterEach(async () => {
  lockAllTombs();
  kvDelete(PROJECTS_KEY);
  rehydrateProjects();
});

describe("a project's name survives its first unlock (ADR 0089)", () => {
  it("keeps the name typed on the front door until the tomb can seal it", async () => {
    kvDelete(PROJECTS_KEY);
    rehydrateProjects();
    // Typed before any tomb is open: the name lives only in memory.
    const project = await createProject("Side");
    expect(listProjects().find((p) => p.id === project.id)?.name).toBe("Side");

    // The new tomb is sealed with its own key and opened; it has no sealed
    // projects view yet. The boot view alone would rename it to its id.
    await setActiveProject(project.id);
    const store = new VaultStore();
    store.loadActiveProjectScope();
    await store.create(PASSWORD);
    await hydrateProjectsFromVfs(project.id);
    expect(listProjects().find((p) => p.id === project.id)?.name).toBe("Side");
    expect(listProjects()[0]?.id).toBe(PERSONAL_PROJECT_ID);
    store.lock();
    await setActiveProject(PERSONAL_PROJECT_ID);
  });

  it("seals the name into a shared-key project's own view when it is forked", async () => {
    kvDelete(PROJECTS_KEY);
    rehydrateProjects();
    const store = new VaultStore();
    store.loadActiveProjectScope();
    await store.create(PASSWORD);
    const project = await createProject("Work");
    await setActiveProject(project.id);
    await store.forkUnlockedIntoActiveScope();

    // Lock (which drops every in-memory view) and come back in through the
    // shared key: the name must be read from Work's own sealed view.
    await setActiveProject(PERSONAL_PROJECT_ID);
    store.loadActiveProjectScope();
    await store.unlock(PASSWORD);
    await setActiveProject(project.id);
    await store.openActiveScopeWithCurrentKey();
    expect(listProjects().find((p) => p.id === project.id)?.name).toBe("Work");
    store.lock();
    await setActiveProject(PERSONAL_PROJECT_ID);
  });
});
