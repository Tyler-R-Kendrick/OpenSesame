import { createItem } from "@opensesame/vault-core";
import { expect, it } from "vitest";
import { installFileBackedVfs } from "./secret-fs/install.js";
import { makeMemorySecretFiles } from "./secret-fs/memory.js";
import { PASSWORD, newStore } from "./vault/store-ops.fixture.js";
import { installUnlockRacesFixture } from "./vault/store-unlock-races.fixture.js";
import { vfsSeams } from "./vfs.js";

installUnlockRacesFixture();

it("a legacy file backend unlocks a no-quorum vault without guarded IAM writes", async () => {
  const restore = await installFileBackedVfs(makeMemorySecretFiles());
  const source = newStore();
  const reopened = newStore();
  try {
    expect(vfsSeams.writeRawGuarded).toBeUndefined();
    await source.create(PASSWORD);
    await source.saveItem(createItem("note", "Legacy backend retained note"));
    source.lock();
    reopened.rehydrate();
    await reopened.unlock(PASSWORD);
    expect(reopened.isUnlocked()).toBe(true);
    expect(reopened.getSnapshot().trustedUnlock).toBeNull();
    expect(reopened.getSnapshot().items.map((item) => item.name)).toEqual([
      "Legacy backend retained note",
    ]);
  } finally {
    source.lock();
    reopened.lock();
    await source.flushPendingWrites();
    await reopened.flushPendingWrites();
    restore();
  }
});
