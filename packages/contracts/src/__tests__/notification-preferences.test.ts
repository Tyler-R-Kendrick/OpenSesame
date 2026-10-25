import { describe, expect, it } from "vitest";
import { UpdateNotificationPreferencesSchema } from "../notifications.js";

describe("notification preference classes", () => {
  it("keeps preferences sparse while rejecting unknown classes", () => {
    expect(UpdateNotificationPreferencesSchema.parse({ byClass: {} })).toEqual({
      byClass: {},
    });
    expect(
      UpdateNotificationPreferencesSchema.safeParse({
        byClass: { unknown: { channels: [] } },
      }).success,
    ).toBe(false);
  });
});
