import { describe, expect, it } from "vitest";
import { createCursor } from "@opensesame/client-core";

describe("pwa shell", () => {
  it("creates a device sync cursor", () => {
    expect(createCursor("pwa").deviceId).toBe("pwa");
  });
});
