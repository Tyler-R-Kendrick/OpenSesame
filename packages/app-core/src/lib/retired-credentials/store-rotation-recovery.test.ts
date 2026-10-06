import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { makeOpfs } from "../duress/wipe/fake-opfs.test-support.js";
import { kvForgetAll, kvGet, kvHydrate } from "../kv.js";
import { hasPendingRotationJournal } from "../vault/rotation-journal.js";
import { VaultStore } from "../vault/store.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  SEAL_BOUND_MARKER_PATH,
  readFile,
  tombFileKey,
  vfsSeams,
  writeFile,
} from "../vfs.js";
import { PASSWORD, createRetiredCredentialFixture } from "./test-support.js";
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
let fresh: VaultStore | null = null;
beforeEach(async () => {
  const opfs = makeOpfs();
  vi.stubGlobal("navigator", {
    storage: { getDirectory: async () => opfs },
    locks: webLocksDouble(),
  });
  configureHost(createTestHost());
  fixture = await createRetiredCredentialFixture();
  await fixture.store.saveItem(createItem("note", "Preserved owner item"));
  await writeFile(
    "personal",
    "proof/rotation.txt",
    new TextEncoder().encode("preserved owner file"),
  );
});
afterEach(() => {
  fresh?.lock();
  fresh = null;
  fixture.restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  configureHost(createTestHost());
});
it.each(["file", "header"] as const)(
  "rolls forward actual persistent ciphertext after a %s publication fault and a cold KV restart",
  async (fault) => {
    const previous = kvGet(tombFileKey("personal", HEADER_PATH));
    const write = vfsSeams.writeRaw;
    let fired = false;
    const target = tombFileKey(
      "personal",
      fault === "file" ? "proof/rotation.txt" : HEADER_PATH,
    );
    const fail = vi
      .spyOn(vfsSeams, "writeRaw")
      .mockImplementation(async (key, value) => {
        await write(key, value);
        if (!fired && key === target) {
          fired = true;
          throw new Error("Actual durable publication interrupted");
        }
      });
    await expect(
      fixture.store.protection.rotateCompromisedRoot({ password: PASSWORD }),
    ).rejects.toThrow(/interrupted/);
    expect(fired).toBe(true);
    expect(hasPendingRotationJournal("personal")).toBe(true);
    if (fault === "file")
      expect(kvGet(tombFileKey("personal", HEADER_PATH))).toBe(previous);
    await expect(
      writeFile("personal", "proof/blocked.txt", new Uint8Array([9])),
    ).rejects.toThrow();
    fail.mockRestore();
    fixture.store.lock();
    kvForgetAll();
    await kvHydrate(
      [
        HEADER_PATH,
        BODY_PATH,
        INDEX_PATH,
        MIGRATION_MARKER_PATH,
        SEAL_BOUND_MARKER_PATH,
      ].map((path) => tombFileKey("personal", path)),
    );
    fresh = new VaultStore();
    await fresh.unlock(PASSWORD);
    expect(hasPendingRotationJournal("personal")).toBe(false);
    expect(fresh.getSnapshot().items.map((item) => item.name)).toEqual([
      "Preserved owner item",
    ]);
    expect(
      new TextDecoder().decode(
        await readFile("personal", "proof/rotation.txt"),
      ),
    ).toBe("preserved owner file");
    await writeFile("personal", "proof/after.txt", new Uint8Array([7]));
    expect(await readFile("personal", "proof/after.txt")).toEqual(
      new Uint8Array([7]),
    );
  },
);
it("retains a partial journal on cancellation and completes fresh original-owner authentication after a synthetic realm", async () => {
  const write = vfsSeams.writeRaw;
  let reached = () => {};
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let resume = () => {};
  const blocked = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let fired = false;
  vi.spyOn(vfsSeams, "writeRaw").mockImplementation(async (key, value) => {
    await write(key, value);
    if (!fired && key === tombFileKey("personal", "proof/rotation.txt")) {
      fired = true;
      reached();
      await blocked;
    }
  });
  const pending = fixture.store.protection
    .rotateCompromisedRoot({ password: PASSWORD })
    .then(
      () => null,
      (error: Error) => error,
    );
  await started;
  fixture.store.lock();
  await fixture.store.createGuest({
    decoy: true,
    isolated: true,
    resume: false,
  });
  resume();
  expect(await pending).toBeInstanceOf(Error);
  expect(fixture.store.getSnapshot().decoy).toBe(true);
  expect(hasPendingRotationJournal("personal")).toBe(true);
  fixture.store.lock();
  await fixture.store.unlock(PASSWORD);
  expect(fixture.store.getSnapshot().status).toBe("unlocked");
  expect(
    new TextDecoder().decode(await readFile("personal", "proof/rotation.txt")),
  ).toBe("preserved owner file");
  expect(hasPendingRotationJournal("personal")).toBe(false);
});
