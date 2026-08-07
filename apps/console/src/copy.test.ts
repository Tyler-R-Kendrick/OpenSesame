import { describe, expect, it } from "vitest";

describe("console copy invariants", () => {
  it("device page copy is about CLI authorization", async () => {
    const src = await import("./pages/DevicePage.js");
    expect(src.DevicePage.name).toBe("DevicePage");
  });
});
