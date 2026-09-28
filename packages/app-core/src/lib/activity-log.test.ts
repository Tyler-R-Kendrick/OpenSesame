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

  it("scrubs a secret a caller left in the summary or the target", async () => {
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    const rows = await recordActivityEvent(PERSONAL_TOMB, {
      category: "request",
      type: "request.failed",
      summary:
        "claim failed: https://app.example/claim#token=osc_clm_AbC.s3cr3tpart",
      targetType: "claim",
      targetId: "https://x.example/cb?code=abc123",
    });
    expect(JSON.stringify(rows)).not.toMatch(/osc_clm_|s3cr3tpart|abc123/);
    expect(rows[0]?.summary).toContain("claim failed");
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
});
