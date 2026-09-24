/**
 * A guest's actions are logged in the guest's own tomb, never in the sealed
 * vault beside it (PRODUCT.md: guests are first-class; AGENTS.md: the guest
 * tomb is isolated).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  activitySeams,
  listActivityEvents,
  recordActivityEvent,
} from "../activity-log.js";
import { GUEST_TOMB } from "../vfs.js";
import { vaultStore } from "./store.js";

afterEach(() => {
  vaultStore.lock();
});

describe("activity for a guest", () => {
  it("is recorded in the guest tomb while the guest vault is open", async () => {
    await vaultStore.createGuest();
    expect(activitySeams.activeTomb()).toBe(GUEST_TOMB);

    await recordActivityEvent(GUEST_TOMB, {
      category: "settings",
      type: "settings.updated",
      summary: "Settings updated",
    });
    const events = await listActivityEvents(GUEST_TOMB);
    expect(events.map((event) => event.type)).toContain("settings.updated");
  });

  it("goes nowhere once the vault is locked", async () => {
    await vaultStore.createGuest();
    vaultStore.lock();
    expect(activitySeams.activeTomb()).toBeNull();
  });
});
