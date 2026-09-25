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

describe("a vault that left is not listed by its siblings (ADR 0143)", () => {
  it("scrubs the name from a sibling's sealed view on its next unlock", async () => {
    const { store, work, trip } = await personalWithTwoProjects();
    // Personal's own view still names Work: it was written while open.
    await setActiveProject(PERSONAL_PROJECT_ID);
    store.lock();
    store.loadActiveProjectScope();
    await store.unlock(PASSWORD);
    await hydrateProjectsFromVfs(PERSONAL_PROJECT_ID);
    expect(await sealedView(PERSONAL_PROJECT_ID)).toContain("Work");
    store.lock();

    // Work leaves while personal is locked.
    await unregisterTomb(work.id);
    store.loadActiveProjectScope();
    await store.unlock(PASSWORD);
    await hydrateProjectsFromVfs(PERSONAL_PROJECT_ID);
    const ids = listProjects().map((p) => p.id);
    expect(ids).toContain(trip.id);
    expect(ids).not.toContain(work.id);
    expect(await sealedView(PERSONAL_PROJECT_ID)).not.toContain("Work");
    expect(await sealedView(PERSONAL_PROJECT_ID)).not.toContain(work.id);
    expect(await sealedView(PERSONAL_PROJECT_ID)).toContain(trip.id);

    // It comes home: listed again, by id until its own view is opened.
    await registerTomb(work.id);
    await refreshProjectsView();
    expect(listProjects().map((p) => p.id)).toContain(work.id);
    expect(listTombs()).toContain(work.id);

    // Trip leaves from the open session: gone from the list at once, and
    // the active pointer falls back to a vault that is still here.
    await setActiveProject(trip.id);
    await unregisterTomb(trip.id);
    await forgetDepartedProjects([trip.id]);
    expect(listProjects().map((p) => p.id)).not.toContain(trip.id);
    expect(await sealedView(PERSONAL_PROJECT_ID)).not.toContain(trip.id);
    store.lock();
    rehydrateProjects();
    expect(listProjects().map((p) => p.id)).not.toContain(trip.id);
  });
});
