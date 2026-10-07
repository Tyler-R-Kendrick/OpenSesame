import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as digest from "../duress/store/vault-session-digest.js";
import { kvDelete } from "../kv.js";
import {
  PERSONAL_PROJECT_ID,
  PROJECTS_KEY,
  createProject,
  rehydrateProjects,
  setActiveProject,
} from "../projects.js";
import * as body from "../vault/store-body.js";
import { retiredCredentialStatus } from "./index.js";
import { openRetiredCredentialDecoy } from "./session.js";
import { PASSWORD, createRetiredCredentialFixture } from "./test-support.js";
import { unlockWithRetiredCredentialGate } from "./unlock.js";
function deferred() {
  let finish = () => {};
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish: () => finish() };
}
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  kvDelete(PROJECTS_KEY);
  rehydrateProjects();
  fixture = await createRetiredCredentialFixture();
  await fixture.enroll("selected retired password", "synthetic_decoy");
});
afterEach(() => {
  vi.restoreAllMocks();
  fixture.restore();
});
it.each(["open", "fork"] as const)(
  "refuses a real %s carry after an actual root digest completes in a successor synthetic session",
  async (mode) => {
    const project = await createProject("Shared authority");
    await setActiveProject(project.id);
    if (mode === "open") {
      await fixture.store.forkUnlockedIntoActiveScope();
      await setActiveProject(PERSONAL_PROJECT_ID);
      fixture.store.loadActiveProjectScope();
      await fixture.store.unlock(PASSWORD);
      await setActiveProject(project.id);
    }
    const reached = deferred();
    const blocked = deferred();
    const original = digest.sessionRootDigestFromKey;
    vi.spyOn(digest, "sessionRootDigestFromKey").mockImplementationOnce(
      async (...args) => {
        const actual = await original(...args);
        reached.finish();
        await blocked.promise;
        return actual;
      },
    );
    const pending = (
      mode === "open"
        ? fixture.store.openActiveScopeWithCurrentKey()
        : fixture.store.forkUnlockedIntoActiveScope()
    ).then(
      () => null,
      (error: Error) => error,
    );
    await reached.promise;
    fixture.store.lock();
    await unlockWithRetiredCredentialGate(
      fixture.store,
      "selected retired password",
    );
    const current = fixture.store.getSnapshot();
    blocked.finish();
    expect(await pending).toBeInstanceOf(Error);
    expect(fixture.store.getSnapshot()).toEqual(current);
    expect(current).toMatchObject({ decoy: true, guest: true });
  },
);

it("never rolls the previous real key and body back into a synthetic successor after a late target-body read", async () => {
  const trap = retiredCredentialStatus("personal").traps[0];
  if (!trap) throw new Error("Expected an enrolled trap");
  const shared = await createProject("Shared key");
  await setActiveProject(shared.id);
  await fixture.store.forkUnlockedIntoActiveScope();
  await setActiveProject(PERSONAL_PROJECT_ID);
  fixture.store.loadActiveProjectScope();
  await fixture.store.unlock(PASSWORD);
  await setActiveProject(shared.id);
  const reached = deferred();
  const blocked = deferred();
  const read = body.loadVaultBody;
  vi.spyOn(body, "loadVaultBody").mockImplementationOnce(async (...args) => {
    const actual = await read(...args);
    reached.finish();
    await blocked.promise;
    return actual;
  });
  const pending = fixture.store.openActiveScopeWithCurrentKey().then(
    () => null,
    (error: Error) => error,
  );
  await reached.promise;
  fixture.store.lock();
  await openRetiredCredentialDecoy(fixture.store, trap, "personal");
  const current = fixture.store.getSnapshot();
  blocked.finish();
  expect(await pending).toBeInstanceOf(Error);
  expect(fixture.store.getSnapshot()).toEqual(current);
  expect(current).toMatchObject({ decoy: true, guest: true });
});
