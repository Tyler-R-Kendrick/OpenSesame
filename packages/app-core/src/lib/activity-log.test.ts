import { mintVaultKey } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it } from "vitest";
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    const listed = await listActivityEvents(PERSONAL_TOMB);
    expect(listed.map((row) => row.type)).toEqual([
      "settings.updated",
      "request.inbound.created",
    ]);
  });
});
