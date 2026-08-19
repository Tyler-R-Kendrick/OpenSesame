import { createCursor } from "@opensesame/client-core";
import { describe, expect, it } from "vitest";

describe("pwa shell", () => {
  it("creates a device sync cursor", () => {
    expect(createCursor("pwa").deviceId).toBe("pwa");
  });
});
