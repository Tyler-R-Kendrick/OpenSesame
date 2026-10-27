import { describe, expect, it } from "vitest";
import { OpaqueScreenshotMasker, maskObservation } from "./masking.js";
import { ORIGIN, observation } from "./test-support.js";

describe("model observation masking", () => {
  it("removes raw images and sensitive field text before model state", async () => {
    const safe = await maskObservation({
      ...observation([{ ref: "e1", kind: "email", label: "person@example.test" }]),
      screenshot: "data:image/png;base64,RAW_SCREENSHOT_CANARY",
      sensitiveValues: ["person@example.test"],
    }, new OpaqueScreenshotMasker());
    expect(JSON.stringify(safe)).not.toContain("RAW_SCREENSHOT_CANARY");
    expect(JSON.stringify(safe)).not.toContain("person@example.test");
    expect(safe.screenshot).toBeUndefined();
    expect(safe.maskedScreenshot).toContain("data:image/png;base64,");
    expect(safe.origin).toBe(ORIGIN);
  });

  it("fails closed when a raw screenshot cannot be masked", async () => {
    await expect(maskObservation({
      ...observation(),
      screenshot: "data:image/png;base64,RAW_SCREENSHOT_CANARY",
    })).rejects.toThrow("masked screenshot");
  });
});
