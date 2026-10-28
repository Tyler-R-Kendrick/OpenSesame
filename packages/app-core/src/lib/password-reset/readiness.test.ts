import { describe, expect, it } from "vitest";
import { forgetDeviceConnectors } from "../device-connectors.js";
import {
  evaluatePasswordResetReadiness,
  passwordResetFeatureApproved,
} from "./readiness.js";

describe("password reset readiness", () => {
  it("requires the feature capability", () => {
    expect(passwordResetFeatureApproved([])).toBe(false);
    expect(passwordResetFeatureApproved(["ai.password-reset"])).toBe(true);
  });

  it("refuses when no computer-use runtime is saved", async () => {
    await forgetDeviceConnectors();
    const verdict = await evaluatePasswordResetReadiness(
      ["ai.password-reset"],
      { kind: "browser", browserPlane: "builtin", because: "configured" },
    );
    expect(verdict).toEqual({ ok: false, reason: "runtime" });
  });
});
