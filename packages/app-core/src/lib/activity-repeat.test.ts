import { mintVaultKey } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVITY_LOG_PATH,
  activitySeams,
  listActivityEvents,
  recordActivityEvent,
} from "./activity-log.js";
import { kvDelete } from "./kv.js";
import {
  INDEX_PATH,
  PERSONAL_TOMB,
  lockAllTombs,
  tombFileKey,
  unlockTomb,
  vfsFlush,
} from "./vfs.js";

/**
 * Activity is a log a person reads. An invalidation that fires once per
 * store it touches, fifteen times in a second, was fifteen identical rows.
 */
describe("activity log repeats", () => {
  beforeEach(async () => {
    await vfsFlush();
    lockAllTombs();
    kvDelete(tombFileKey(PERSONAL_TOMB, ACTIVITY_LOG_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
    activitySeams.activeTomb = () => null;
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
  });

  const changed = {
    category: "identity",
    type: "identity.changed",
    summary: "Identity or access state changed",
  } as const;

  it("folds a burst of the same event into one line", async () => {
    for (let index = 0; index < 5; index += 1) {
      await recordActivityEvent(PERSONAL_TOMB, changed);
    }
    const events = await listActivityEvents(PERSONAL_TOMB);
    expect(events.map((event) => event.type)).toEqual(["identity.changed"]);
  });

  it("keeps a repeat once something else happened between", async () => {
    await recordActivityEvent(PERSONAL_TOMB, changed);
    await recordActivityEvent(PERSONAL_TOMB, {
      category: "settings",
      type: "settings.updated",
      summary: "Settings updated",
    });
    await recordActivityEvent(PERSONAL_TOMB, changed);
    const events = await listActivityEvents(PERSONAL_TOMB);
    expect(events.map((event) => event.type)).toEqual([
      "identity.changed",
      "settings.updated",
      "identity.changed",
    ]);
  });
});
