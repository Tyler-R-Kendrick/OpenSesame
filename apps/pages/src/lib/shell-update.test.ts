import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  UPDATE_READY_LABEL,
  shellPresenceLabel,
  syncShellUpdateNotice,
} from "./shell-update.js";

afterEach(clearNotices);

describe("shell presence", () => {
  it("names offline and a waiting release, and says nothing when neither is true", () => {
    expect(shellPresenceLabel({ offline: false, updateReady: false })).toBe(
      null,
    );
    expect(shellPresenceLabel({ offline: true, updateReady: false })).toBe(
      "Offline",
    );
    expect(shellPresenceLabel({ offline: false, updateReady: true })).toBe(
      UPDATE_READY_LABEL,
    );
    expect(shellPresenceLabel({ offline: true, updateReady: true })).toBe(
      `Offline. ${UPDATE_READY_LABEL}`,
    );
    expect(UPDATE_READY_LABEL).toBe("Update ready — Save, then reload");
  });

  it("puts a waiting release in the tray and takes it down when the release is gone", () => {
    syncShellUpdateNotice(true);
    expect(listNotices()).toMatchObject([
      {
        id: "shell:update-ready",
        tone: "warn",
        title: "Update ready",
        body: "Save, then reload.",
      },
    ]);
    syncShellUpdateNotice(true);
    expect(listNotices()).toHaveLength(1);
    syncShellUpdateNotice(false);
    expect(listNotices()).toEqual([]);
  });
});
