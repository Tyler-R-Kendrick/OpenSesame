import { mintVaultKey } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_LOG_PATH,
  activitySeams,
  emitActivity,
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

describe("activity log", () => {
  beforeEach(async () => {
    await vfsFlush();
    lockAllTombs();
    kvDelete(tombFileKey(PERSONAL_TOMB, ACTIVITY_LOG_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
    activitySeams.activeTomb = () => null;
  });

  it("seals events under the vault and ignores emit without a tomb", async () => {
    emitActivity({
      category: "settings",
      type: "settings.updated",
      summary: "should not land",
    });
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    const first = await recordActivityEvent(PERSONAL_TOMB, {
      category: "request",
      type: "request.inbound.created",
      summary: "Inbound access request received",
      outcome: "info",
      targetType: "access_request",
      targetId: "req-1",
    });
    expect(first).toHaveLength(1);
    expect(first[0]?.summary).toBe("Inbound access request received");
    activitySeams.activeTomb = () => PERSONAL_TOMB;
    emitActivity({
      category: "settings",
      type: "settings.updated",
      summary: "Settings updated",
      outcome: "succeeded",
    });
    // emitActivity is fire-and-forget: wait for its write to land rather
    // than for a fixed time, which a loaded machine can outlast.
    await vi.waitFor(async () => {
      const listed = await listActivityEvents(PERSONAL_TOMB);
      expect(listed.map((row) => row.type)).toEqual([
        "settings.updated",
        "request.inbound.created",
      ]);
    });
  });

  it("keeps both events from overlapping appends", async () => {
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    await Promise.all([
      recordActivityEvent(PERSONAL_TOMB, {
        category: "settings",
        type: "settings.updated",
        summary: "First append",
      }),
      recordActivityEvent(PERSONAL_TOMB, {
        category: "vault",
        type: "vault.unlocked",
        summary: "Second append",
      }),
    ]);
    const listed = await listActivityEvents(PERSONAL_TOMB);
    expect(listed.map((row) => row.summary).sort()).toEqual([
      "First append",
      "Second append",
    ]);
  });
});
