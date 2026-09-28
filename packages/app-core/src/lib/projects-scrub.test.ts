import { afterEach, describe, expect, it } from "vitest";
import { kvDelete } from "./kv.js";
import {
  PERSONAL_PROJECT_ID,
  PROJECTS_CONFIG_PATH,
  PROJECTS_KEY,
  createProject,
  hydrateProjectsFromVfs,
  listProjects,
  rehydrateProjects,
  setActiveProject,
} from "./projects.js";
import { VaultStore } from "./vault/store.js";
import { lockAllTombs, unregisterTomb, vfsSeams } from "./vfs.js";

const PASSWORD = "correct horse battery staple";

afterEach(() => {
  lockAllTombs();
  kvDelete(PROJECTS_KEY);
  rehydrateProjects();
});

describe("the unlock-time scrub (ADR 0143)", () => {
  it("drops a vault that left, and keeps the others' names when the rewrite fails", async () => {
    kvDelete(PROJECTS_KEY);
    rehydrateProjects();
    const store = new VaultStore();
    store.loadActiveProjectScope();
    await store.create(PASSWORD);
    // Both named from personal, so personal's sealed view lists both.
    const work = await createProject("Work");
    const trip = await createProject("Trip");
    for (const project of [work, trip]) {
      await setActiveProject(project.id);
      await store.forkUnlockedIntoActiveScope();
    }
    await setActiveProject(PERSONAL_PROJECT_ID);
    store.lock();
    // Trip left this device while personal was locked.
    await unregisterTomb(trip.id);
    store.loadActiveProjectScope();
    // Unlocking hydrates the list and scrubs Trip; the rewrite is refused.
    const writeRaw = vfsSeams.writeRaw;
    vfsSeams.writeRaw = (key, value) =>
      key.endsWith(PROJECTS_CONFIG_PATH)
        ? Promise.reject(new Error("QuotaExceededError"))
        : writeRaw(key, value);
    try {
      await store.unlock(PASSWORD);
      await hydrateProjectsFromVfs(PERSONAL_PROJECT_ID);
    } finally {
      vfsSeams.writeRaw = writeRaw;
    }
    expect(listProjects().map((p) => [p.id, p.name])).toEqual([
      [PERSONAL_PROJECT_ID, "Personal"],
      [work.id, "Work"],
    ]);
    store.lock();
  });
});
