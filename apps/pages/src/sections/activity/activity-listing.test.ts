import type { ActivityEvent } from "@opensesame/app-core/lib/activity-log.js";
import { afterEach, describe, expect, it } from "vitest";
import { LISTING_PAGE_SIZE } from "../../lib/listing-page.js";
import {
  activityHref,
  activityIdFromHash,
  activityListing,
  activityRowId,
  filterActivity,
  resetActivityListing,
  revealActivity,
  setActivityQuery,
  showMoreActivity,
} from "./activity-listing.js";

function event(
  id: string,
  summary: string,
  extra: Partial<ActivityEvent> = {},
): ActivityEvent {
  return {
    id,
    occurredAt: "2026-09-01T10:00:00.000Z",
    category: "vault",
    type: "vault.unlocked",
    summary,
    outcome: "info",
    targetType: null,
    targetId: null,
    metadata: {},
    ...extra,
  };
}

afterEach(resetActivityListing);

describe("activity listing", () => {
  it("searches what the row shows, case-insensitively, in log order", () => {
    const events = [
      event("a", "Vault unlocked"),
      event("b", "Settings updated", {
        category: "settings",
        type: "settings.updated",
      }),
      event("c", "Connection created", {
        category: "connection",
        type: "connection.created",
        targetId: "conn-42",
      }),
    ];
    expect(filterActivity(events, "").map((row) => row.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(filterActivity(events, "  SETTINGS ").map((row) => row.id)).toEqual([
      "b",
    ]);
    expect(filterActivity(events, "conn-42").map((row) => row.id)).toEqual([
      "c",
    ]);
    expect(filterActivity(events, "nothing")).toEqual([]);
  });

  it("links a rail entry to the page row it names", () => {
    expect(activityHref("a b")).toBe("/activity#activity-a%20b");
    expect(activityRowId("a b")).toBe("activity-a b");
    expect(activityIdFromHash("#activity-a%20b")).toBe("a b");
    expect(activityIdFromHash("#activity-")).toBeNull();
    expect(activityIdFromHash("#log")).toBeNull();
  });

  it("pages by the shared step, and a new search starts at one page", () => {
    expect(activityListing("t").limit).toBe(LISTING_PAGE_SIZE);
    showMoreActivity("t");
    expect(activityListing("t").limit).toBe(LISTING_PAGE_SIZE * 2);
    setActivityQuery("t", "Vault");
    expect(activityListing("t")).toEqual({
      tomb: "t",
      query: "vault",
      limit: LISTING_PAGE_SIZE,
    });
  });

  it("grows to reveal a deep-linked row and never shrinks for one", () => {
    revealActivity("t", LISTING_PAGE_SIZE * 2 + 1);
    expect(activityListing("t").limit).toBe(LISTING_PAGE_SIZE * 3);
    revealActivity("t", 0);
    expect(activityListing("t").limit).toBe(LISTING_PAGE_SIZE * 3);
  });

  it("belongs to one tomb: another reads the defaults, stably", () => {
    setActivityQuery("personal", "vault");
    showMoreActivity("personal");
    const other = activityListing("project");
    expect(other).toEqual({
      tomb: "project",
      query: "",
      limit: LISTING_PAGE_SIZE,
    });
    expect(activityListing("project")).toBe(other);
    expect(activityListing("personal").query).toBe("vault");
  });
});
