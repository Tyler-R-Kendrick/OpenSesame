import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROTATION_INTERVAL_DAYS,
  itemHasGenerator,
  itemRotationMode,
  itemRotationWarning,
} from "./rotation.js";

describe("item rotation capabilities", () => {
  it("marks the web login as the only provider-rotatable type", () => {
    expect(itemRotationMode("account")).toBe("automatic");
    expect(itemRotationMode("card")).toBe("manual");
    expect(itemRotationMode("note")).toBe("none");
  });

  it("uses one default schedule", () => {
    expect(DEFAULT_ROTATION_INTERVAL_DAYS).toBe(30);
  });

  it("warns on generator-backed types with no provider path", () => {
    expect(itemRotationWarning("card")).toMatch(/couldn't verify/u);
    expect(itemRotationWarning("account")).toBeNull();
    expect(itemRotationWarning("note")).toBeNull();
    expect(itemHasGenerator("card")).toBe(true);
    expect(itemHasGenerator("note")).toBe(false);
  });
});
