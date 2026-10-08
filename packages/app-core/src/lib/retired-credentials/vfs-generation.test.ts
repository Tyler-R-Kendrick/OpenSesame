import { createItem, mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as projects from "../projects.js";
import { VaultStore } from "../vault/store.js";
import * as files from "../vfs.js";
import { PASSWORD, createRetiredCredentialFixture } from "./test-support.js";
function deferred() {
  let finish = () => {};
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish: () => finish() };
}
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
let synthetic: VaultStore | null = null;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
  await files.writeFile(
    "personal",
    "proof/private.txt",
    new TextEncoder().encode("real owner information"),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  synthetic?.lock();
  synthetic = null;
  fixture.restore();
});
async function enterSeparateSyntheticStore() {
  synthetic = new VaultStore();
  await synthetic.createGuest({ decoy: true, isolated: true, resume: false });
  return synthetic.activeTomb();
}
it("denies direct sealed I/O to an already-open real owner's key while admitting only the independent synthetic scratch root", async () => {
  await fixture.store.saveItem(createItem("account", "private owner account"));
  const real = fixture.store.getSnapshot();
  const guest = new VaultStore();
  await guest.createGuest({ resume: false });
  await files.writeFile(
    "guest",
    "proof/private.txt",
    new TextEncoder().encode("previous ordinary guest information"),
  );
  // Keep both real and ordinary guest keys admitted; use a third independent store.
  const scratch = await enterSeparateSyntheticStore();
  for (const tomb of ["personal", "guest"]) {
    await expect(
      files.readFile(tomb, "proof/private.txt"),
    ).rejects.toMatchObject({ code: "locked" });
    await expect(files.listDir(tomb, "proof")).rejects.toMatchObject({
      code: "locked",
    });
    await expect(
      files.writeFile(tomb, "proof/private.txt", new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "locked" });
    await expect(
      files.deleteFile(tomb, "proof/private.txt"),
    ).rejects.toMatchObject({ code: "locked" });
  }
  await files.writeFile(scratch, "proof/synthetic.txt", new Uint8Array([7, 8]));
  expect(await files.readFile(scratch, "proof/synthetic.txt")).toEqual(
    new Uint8Array([7, 8]),
  );
  expect(fixture.store.getSnapshot().items).toEqual([]);
  expect(fixture.store.getSnapshot().header).toBeNull();
  expect(fixture.store.getSnapshot()).toBe(fixture.store.getSnapshot());
  expect(fixture.store.isUnlocked()).toBe(false);
  await expect(
    fixture.store.addItems([createItem("account", "blocked mutation")]),
  ).rejects.toThrow();
  await expect(fixture.store.destroy()).rejects.toThrow();
  synthetic?.lock();
  synthetic = null;
  await expect(
    files.readFile("personal", "proof/private.txt"),
  ).rejects.toMatchObject({ code: "locked" });
  expect(fixture.store.getSnapshot().items).toEqual([]);
  await expect(
    fixture.store.addItems([createItem("account", "still blocked")]),
  ).rejects.toThrow();
  fixture.store.lock();
  await fixture.store.unlock(PASSWORD);
  expect(fixture.store.getSnapshot().items).toEqual(real.items);
  expect(
    new TextDecoder().decode(
      await files.readFile("personal", "proof/private.txt"),
    ),
  ).toBe("real owner information");
  guest.lock();
});
it("withholds a retained real plaintext read after actual decryption and successor synthetic admission", async () => {
  const reached = deferred();
  const blocked = deferred();
  const open = files.vfsSeams.open;
  vi.spyOn(files.vfsSeams, "open").mockImplementationOnce(async (...args) => {
    const actual = await open(...args);
    reached.finish();
    await blocked.promise;
    return actual;
  });
  const pending = files.readFile("personal", "proof/private.txt").then(
    () => null,
    (error: Error) => error,
  );
  await reached.promise;
  await enterSeparateSyntheticStore();
  blocked.finish();
  expect(await pending).toMatchObject({ code: "locked" });
});
it("does not acquire a successor real key for a write that was queued under the old key", async () => {
  const reached = deferred();
  const blocked = deferred();
  const seal = files.vfsSeams.seal;
  vi.spyOn(files.vfsSeams, "seal").mockImplementationOnce(async (...args) => {
    const actual = await seal(...args);
    reached.finish();
    await blocked.promise;
    return actual;
  });
  const first = files
    .writeFile("personal", "proof/blocked.txt", new Uint8Array([1]))
    .then(
      () => null,
      (error: Error) => error,
    );
  await reached.promise;
  const queued = files
    .writeFile("personal", "proof/queued.txt", new Uint8Array([2]))
    .then(
      () => null,
      (error: Error) => error,
    );
  fixture.store.lock();
  const successor = await mintVaultKey();
  files.unlockTomb("personal", successor.vaultKey);
  successor.rawVaultKey.fill(0);
  blocked.finish();
  expect(await first).toMatchObject({ code: "locked" });
  expect(await queued).toMatchObject({ code: "locked" });
  expect(files.readSealedFile("personal", "proof/queued.txt")).toBeNull();
});

it("keeps prior admissions revoked when synthetic creation is cancelled before its root is installed", async () => {
  const reached = deferred();
  const blocked = deferred();
  const original = crypto.subtle.importKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "importKey").mockImplementationOnce(
    async (...args) => {
      const key = await original(...args);
      reached.finish();
      await blocked.promise;
      return key;
    },
  );
  synthetic = new VaultStore();
  const pending = synthetic
    .createGuest({ decoy: true, isolated: true, resume: false })
    .then(
      () => null,
      (error: Error) => error,
    );
  await reached.promise;
  synthetic.lock();
  blocked.finish();
  expect(await pending).toBeInstanceOf(Error);
  await expect(
    files.readFile("personal", "proof/private.txt"),
  ).rejects.toMatchObject({ code: "locked" });
  expect(fixture.store.getSnapshot().items).toEqual([]);
});
it("withholds decrypted owner project names in both getters and late hydration after another store enters synthetic", async () => {
  const ownerProject = await projects.createProject("Owner-private project");
  await fixture.store.flushPendingWrites();
  const reached = deferred();
  const blocked = deferred();
  const open = files.vfsSeams.open;
  vi.spyOn(files.vfsSeams, "open").mockImplementationOnce(async (...args) => {
    const actual = await open(...args);
    reached.finish();
    await blocked.promise;
    return actual;
  });
  const pending = projects.hydrateProjectsFromVfs("personal").then(
    () => null,
    (error: Error) => error,
  );
  await reached.promise;
  await enterSeparateSyntheticStore();
  expect(
    projects
      .listProjects()
      .some((project) => project.name === ownerProject.name),
  ).toBe(false);
  expect(projects.activeProject().name).toBe("Personal");
  expect(projects.projectsState()).toBe(projects.projectsState());
  blocked.finish();
  expect(await pending).toBeInstanceOf(Error);
  expect(
    projects
      .listProjects()
      .some((project) => project.name === ownerProject.name),
  ).toBe(false);
  synthetic?.lock();
  synthetic = null;
  expect(
    projects
      .listProjects()
      .some((project) => project.name === ownerProject.name),
  ).toBe(false);
  fixture.store.lock();
  await fixture.store.unlock(PASSWORD);
  expect(
    projects
      .listProjects()
      .some((project) => project.name === ownerProject.name),
  ).toBe(true);
});

it("does not let a retained real store lock or ordinary guest creation dismiss another store's active synthetic realm", async () => {
  await enterSeparateSyntheticStore();
  fixture.store.lock();
  const { isDecoySession, requiresFreshOwnerAuthentication } = await import(
    "../decoy-session.js"
  );
  const { hostFetch, identitySeams } = await import("../identity.js");
  const transport = vi
    .spyOn(identitySeams, "hostFetch")
    .mockResolvedValue(new Response("owner data"));
  expect(isDecoySession()).toBe(true);
  const unrelated = new VaultStore();
  await expect(unrelated.createGuest({ resume: false })).rejects.toThrow();
  expect(isDecoySession()).toBe(true);
  await expect(hostFetch("/api/v1/member")).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
  synthetic?.lock();
  synthetic = null;
  expect(requiresFreshOwnerAuthentication()).toBe(true);
  await fixture.store.unlock(PASSWORD);
  expect(requiresFreshOwnerAuthentication()).toBe(false);
});
