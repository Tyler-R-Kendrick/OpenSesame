import { overlapCast } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { broadcastHub } from "../browser-reset.fixture.js";
import { kvForgetAll, kvGet } from "../kv.js";
import { HEADER_PATH, lockAllTombs, tombFileKey } from "../vfs.js";
import {
  announceVaultDestroyed,
  resetVaultDestroyChannelForTest,
} from "./lock-events.js";
import { VaultStore } from "./store.js";

const PASSWORD = "correct horse battery staple";

beforeEach(() => {
  kvForgetAll();
  lockAllTombs();
  resetVaultDestroyChannelForTest();
  const locks = webLocksDouble();
  const hub = broadcastHub();
  configureHost(
    createTestHost({
      locks: overlapCast(locks),
      broadcast: hub.open,
    }),
  );
});

describe("vault destruction fencing", () => {
  it("keeps the header when another open session fences destruction", async () => {
    const open = new VaultStore();
    await open.create(PASSWORD);
    const destroyer = new VaultStore();
    await destroyer.unlock(PASSWORD);
    const tomb = open.getSnapshot().tomb;
    expect(kvGet(tombFileKey(tomb, HEADER_PATH))).not.toBeNull();

    await expect(destroyer.destroy()).rejects.toThrow(
      /changed in another tab/i,
    );
    expect(kvGet(tombFileKey(tomb, HEADER_PATH))).not.toBeNull();
    expect(open.isUnlocked()).toBe(true);
    // A failed destroy is not an empty store: the locked header keeps
    // creation refused until the destructive delete actually commits.
    expect(destroyer.getSnapshot().status).toBe("locked");

    open.lock();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await destroyer.destroy();
    expect(kvGet(tombFileKey(tomb, HEADER_PATH))).toBeNull();
  });

  it("locks an open session when another tab announces the destruction", async () => {
    const open = new VaultStore();
    await open.create(PASSWORD);
    const tomb = open.getSnapshot().tomb;
    expect(open.isUnlocked()).toBe(true);
    announceVaultDestroyed(tomb);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(open.isUnlocked()).toBe(false);
  });
});
