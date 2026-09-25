import { afterEach, describe, expect, it } from "vitest";
import { kvDelete } from "./kv.js";
import {
  PERSONAL_PROJECT_ID,
  PROJECTS_CONFIG_PATH,
  PROJECTS_KEY,
  createProject,
  forgetDepartedProjects,
  hydrateProjectsFromVfs,
  listProjects,
  refreshProjectsView,
  rehydrateProjects,
  setActiveProject,
} from "./projects.js";
import { VaultStore } from "./vault/store.js";
import {
  listTombs,
  lockAllTombs,
  readFile,
  registerTomb,
  unregisterTomb,
} from "./vfs.js";

const PASSWORD = "correct horse battery staple";

afterEach(async () => {
  lockAllTombs();
  kvDelete(PROJECTS_KEY);
  rehydrateProjects();
});

async function personalWithTwoProjects() {
  kvDelete(PROJECTS_KEY);
  rehydrateProjects();
  const store = new VaultStore();
  store.loadActiveProjectScope();
  await store.create(PASSWORD);
  const work = await createProject("Work");
  await setActiveProject(work.id);
  await store.forkUnlockedIntoActiveScope();
  const trip = await createProject("Trip");
  await setActiveProject(trip.id);
  await store.forkUnlockedIntoActiveScope();
  return { store, work, trip };
}

async function sealedView(tomb: string): Promise<string> {
  return new TextDecoder().decode(await readFile(tomb, PROJECTS_CONFIG_PATH));
}

describe("the list after unlock (ADR 0143)", () => {
  it("keeps creation order, and a project nobody sealed yet, across an unlock", async () => {
    const { store, work, trip } = await personalWithTwoProjects();
    await setActiveProject(PERSONAL_PROJECT_ID);
    store.lock();
    store.loadActiveProjectScope();
    await store.unlock(PASSWORD);
    await hydrateProjectsFromVfs(PERSONAL_PROJECT_ID);
    const draft = await createProject("Draft");
    expect(listTombs()).toContain(draft.id);
    store.lock();
    store.loadActiveProjectScope();
    await store.unlock(PASSWORD);
    await hydrateProjectsFromVfs(PERSONAL_PROJECT_ID);
    expect(listProjects().map((p) => p.id)).toEqual([
      PERSONAL_PROJECT_ID,
      work.id,
      trip.id,
      draft.id,
    ]);
    expect(listProjects().find((p) => p.id === draft.id)?.name).toBe("Draft");
    store.lock();
  });
});
